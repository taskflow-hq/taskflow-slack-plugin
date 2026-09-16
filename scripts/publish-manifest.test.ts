import { describe, expect, it, vi } from "vitest";

import { SLACK_PLUGIN_VERSION, createSlackPluginManifest } from "../src/manifest.js";
import { publishSlackPluginManifest } from "./publish-manifest.js";

const env = {
  SLACK_PLUGIN_API_KEY: "synthetic-publish-token",
  PLUGIN_BASE_URL: "https://slack-plugin.example.test",
  MCP_ORIGIN: "https://mcp.example.test",
};
const plugin = {
  id: "plugin-slack",
  slug: "slack",
  version: SLACK_PLUGIN_VERSION,
  visibility: "public",
};

describe("publishSlackPluginManifest", () => {
  it.each([
    ["SLACK_PLUGIN_API_KEY", "SLACK_PLUGIN_API_KEY must be set. Add the stage's STAGING_SLACK_PLUGIN_API_KEY or PROD_SLACK_PLUGIN_API_KEY repository secret in Settings → Secrets → Actions; the key needs plugins:publish:public permission."],
    ["PLUGIN_BASE_URL", "PLUGIN_BASE_URL must be set to the deployed Slack Worker's origin."],
    ["MCP_ORIGIN", "MCP_ORIGIN must be set to the stage's MCP registration origin."],
  ])("requires %s before making a request", async (key, message) => {
    const fetchUpload = vi.fn<typeof fetch>();
    for (const value of [undefined, "", "   "]) {
      await expect(publishSlackPluginManifest({ ...env, [key]: value }, fetchUpload)).rejects.toThrow(message);
    }
    expect(fetchUpload).not.toHaveBeenCalled();
  });

  it("uploads the stage's full manifest with bearer auth and returns the parsed summary", async () => {
    const fetchUpload = vi.fn<typeof fetch>(async (url, init) => {
      expect(url.toString()).toBe(`${env.MCP_ORIGIN}/plugins/upload`);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${env.SLACK_PLUGIN_API_KEY}`);
      expect(headers.get("content-type")).toBe("application/json");
      const body = JSON.parse(await new Response(init?.body).text());
      expect(body).toEqual(createSlackPluginManifest(env.PLUGIN_BASE_URL));
      return Response.json({ plugin: { ...plugin, name: "Slack" }, extra: "ignored" });
    });
    await expect(publishSlackPluginManifest({
      SLACK_PLUGIN_API_KEY: ` ${env.SLACK_PLUGIN_API_KEY} `,
      PLUGIN_BASE_URL: ` ${env.PLUGIN_BASE_URL} `,
      MCP_ORIGIN: ` ${env.MCP_ORIGIN} `,
    }, fetchUpload)).resolves.toEqual({ plugin });
    expect(fetchUpload).toHaveBeenCalledOnce();
  });

  it.each([200, 403, 500])("includes the error response body for HTTP %s", async (status) => {
    const rawBody = JSON.stringify({ error: "publish permission denied" });
    await expect(publishSlackPluginManifest(env, async () => new Response(rawBody, { status })))
      .rejects.toThrow(`Slack plugin ${SLACK_PLUGIN_VERSION} upload failed (HTTP ${status}): ${rawBody}`);
  });

  it("rejects a non-200 response even with a valid summary", async () => {
    await expect(publishSlackPluginManifest(env, async () => Response.json({ plugin }, { status: 201 })))
      .rejects.toThrow("upload failed (HTTP 201)");
  });

  it.each([200, 502])("reports malformed JSON with HTTP %s and the response text", async (status) => {
    await expect(publishSlackPluginManifest(env, async () => new Response("upstream unavailable", { status })))
      .rejects.toThrow(`Slack plugin upload failed (HTTP ${status}): expected JSON; received upstream unavailable`);
  });

  it.each([
    "Plugin version already exists with different manifest bytes",
    "Plugin version must be greater than the current version",
  ])("provides a manifest-version bump hint for %s", async (error) => {
    await expect(publishSlackPluginManifest(env, async () => Response.json({ error }, { status: 409 })))
      .rejects.toThrow("Bump SLACK_PLUGIN_VERSION in src/manifest.ts when bricks, schemas, or endpoint URLs change, then redeploy.");
  });

  it.each([
    { plugin: { ...plugin, id: "" } },
    { plugin: { ...plugin, slug: "core" } },
    { plugin: { ...plugin, version: "0.0.0" } },
    { plugin: { ...plugin, visibility: "private" } },
    {},
    null,
  ])("rejects an invalid success summary: %j", async (body) => {
    await expect(publishSlackPluginManifest(env, async () => Response.json(body)))
      .rejects.toThrow("Slack plugin upload returned an invalid success summary (HTTP 200)");
  });

  it("wraps network failures with the plugin version and preserves the cause", async () => {
    const cause = new Error("connection refused");
    await expect(publishSlackPluginManifest(env, async () => { throw cause; }))
      .rejects.toMatchObject({
        message: `Slack plugin ${SLACK_PLUGIN_VERSION} upload failed: connection refused`,
        cause,
      });
  });
});
