import { pathToFileURL } from "node:url";
import { uploadPluginManifest } from "@flowbrew/plugin-sdk";

import { createSlackPluginManifest } from "../src/manifest.js";

export async function publishSlackPluginManifest(
  env: NodeJS.ProcessEnv = process.env,
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
  return uploadPluginManifest({
    endpoint: new URL("/plugins/upload", mcpOrigin).href,
    apiKey,
    manifest,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const plugin = await publishSlackPluginManifest();
    console.log(`Slack plugin ${plugin.version} registered successfully (new upload or identical reupload; plugin ${plugin.id}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
