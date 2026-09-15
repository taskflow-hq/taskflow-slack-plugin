import { BearerConnection, createPluginDefinition } from "@flowbrew/plugin-sdk";

import { slackBricks } from "./bricks.js";

export const SLACK_PLUGIN_VERSION = "1.0.0";

export function createSlackPlugin(baseUrl: string) {
  return createPluginDefinition({
    slug: "slack", name: "Slack", version: SLACK_PLUGIN_VERSION, visibility: "private",
    connectionTypes: [new BearerConnection("slack", {
      name: "Slack bot token", validationBrick: "slack-auth-test",
    })],
    bricks: slackBricks(baseUrl),
  });
}

export function createSlackPluginManifest(baseUrl: string) {
  return createSlackPlugin(baseUrl).manifest;
}
