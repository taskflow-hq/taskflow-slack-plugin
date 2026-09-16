import { pathToFileURL } from "node:url";
import { z } from "zod";

import { SLACK_PLUGIN_VERSION, createSlackPluginManifest } from "../src/manifest.js";

const uploadResultSchema = z.object({
  plugin: z.object({
    id: z.string().min(1),
    slug: z.literal("slack"),
    version: z.literal(SLACK_PLUGIN_VERSION),
    visibility: z.literal("public"),
  }),
});

export async function publishSlackPluginManifest(
  env: NodeJS.ProcessEnv = process.env,
  fetchUpload: typeof globalThis.fetch = globalThis.fetch,
) {
  const apiKey = env.SLACK_PLUGIN_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "SLACK_PLUGIN_API_KEY must be set. Add the stage's STAGING_SLACK_PLUGIN_API_KEY or PROD_SLACK_PLUGIN_API_KEY repository secret in Settings → Secrets → Actions; the key needs plugins:publish:public permission.",
    );
  }
  const pluginBaseUrl = env.PLUGIN_BASE_URL?.trim();
  if (!pluginBaseUrl) {
    throw new Error("PLUGIN_BASE_URL must be set to the deployed Slack Worker's origin.");
  }
  const mcpOrigin = env.MCP_ORIGIN?.trim();
  if (!mcpOrigin) {
    throw new Error("MCP_ORIGIN must be set to the stage's MCP registration origin.");
  }

  const manifest = createSlackPluginManifest(pluginBaseUrl);
  const uploadUrl = new URL("/plugins/upload", mcpOrigin);
  let response: Response;
  try {
    response = await fetchUpload(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(manifest),
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
  } catch (error) {
    throw new Error(`Slack plugin ${SLACK_PLUGIN_VERSION} upload failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const rawBody = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new Error(`Slack plugin upload failed (HTTP ${response.status}): expected JSON; received ${rawBody}`);
  }
  if (response.status !== 200 || (body && typeof body === "object" && "error" in body)) {
    const hint = /Plugin version already exists with different manifest bytes|Plugin version must be greater than/.test(rawBody)
      ? " Bump SLACK_PLUGIN_VERSION in src/manifest.ts when bricks, schemas, or endpoint URLs change, then redeploy."
      : "";
    throw new Error(`Slack plugin ${SLACK_PLUGIN_VERSION} upload failed (HTTP ${response.status}): ${rawBody}${hint}`);
  }

  // Both a new version and a byte-identical reupload return { plugin: summaryFromManifest(...) }.
  // There is no separate 'created' or 'already registered' flag to check.
  const result = uploadResultSchema.safeParse(body);
  if (!result.success) {
    throw new Error(`Slack plugin upload returned an invalid success summary (HTTP ${response.status}): ${result.error.message}`);
  }
  return result.data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { plugin } = await publishSlackPluginManifest();
    console.log(`Slack plugin ${plugin.version} registered successfully (new upload or identical reupload; plugin ${plugin.id}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
