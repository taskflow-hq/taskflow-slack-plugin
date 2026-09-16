import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadPluginManifest } from "@flowbrew/plugin-sdk";

import { SLACK_PLUGIN_VERSION, createSlackPluginManifest } from "../src/manifest.js";
import { publishSlackPluginManifest } from "./publish-manifest.js";

vi.mock("@flowbrew/plugin-sdk", async (importOriginal) => ({
  ...await importOriginal<typeof import("@flowbrew/plugin-sdk")>(),
  uploadPluginManifest: vi.fn(),
}));

const env = {
  SLACK_PLUGIN_API_KEY: "synthetic-publish-token",
  PLUGIN_BASE_URL: "https://slack-plugin.example.test",
  MCP_ORIGIN: "https://mcp.example.test",
};
const plugin = {
  id: "plugin-slack",
  slug: "slack",
  version: SLACK_PLUGIN_VERSION,
  visibility: "public" as const,
};
const upload = vi.mocked(uploadPluginManifest);
const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  upload.mockReset().mockResolvedValue(plugin);
  // Any accidental network call must fail locally, even with live shell credentials.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("publishSlackPluginManifest", () => {
  it.each([
    ["SLACK_PLUGIN_API_KEY", "SLACK_PLUGIN_API_KEY must be set. Add the stage's STAGING_SLACK_PLUGIN_API_KEY or PROD_SLACK_PLUGIN_API_KEY repository secret in Settings → Secrets → Actions; the key needs plugins:publish:public permission."],
    ["PLUGIN_BASE_URL", "PLUGIN_BASE_URL must be set to the deployed Slack Worker's origin."],
    ["MCP_ORIGIN", "MCP_ORIGIN must be set to the stage's MCP registration origin."],
  ])("requires %s before calling the SDK", async (key, message) => {
    for (const value of [undefined, "", "   "]) {
      await expect(publishSlackPluginManifest({ ...env, [key]: value })).rejects.toThrow(message);
    }
    expect(upload).not.toHaveBeenCalled();
  });

  it("trims configuration, builds the full manifest, and returns the unwrapped plugin", async () => {
    await expect(publishSlackPluginManifest({
      SLACK_PLUGIN_API_KEY: ` ${env.SLACK_PLUGIN_API_KEY} `,
      PLUGIN_BASE_URL: ` ${env.PLUGIN_BASE_URL} `,
      MCP_ORIGIN: ` ${env.MCP_ORIGIN}/ `,
    })).resolves.toBe(plugin);
    expect(upload).toHaveBeenCalledExactlyOnceWith({
      endpoint: `${env.MCP_ORIGIN}/plugins/upload`,
      apiKey: env.SLACK_PLUGIN_API_KEY,
      manifest: createSlackPluginManifest(env.PLUGIN_BASE_URL),
    });
  });
});

describe("CLI entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    process.argv = [process.execPath, fileURLToPath(new URL("./publish-manifest.ts", import.meta.url))];
    process.exitCode = undefined;
  });

  it("prints the unwrapped plugin's version and ID on success", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await import("./publish-manifest.js");
    expect(upload).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `Slack plugin ${plugin.version} registered successfully (new upload or identical reupload; plugin ${plugin.id}).`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("prints an SDK failure and exits unsuccessfully", async () => {
    upload.mockRejectedValue(new Error("Upload failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("./publish-manifest.js");
    expect(error).toHaveBeenCalledExactlyOnceWith("Upload failed");
    expect(process.exitCode).toBe(1);
  });

  it("does not publish when imported by another script", async () => {
    process.argv = [process.execPath, fileURLToPath(import.meta.url)];
    await import("./publish-manifest.js");
    expect(upload).not.toHaveBeenCalled();
  });
});
