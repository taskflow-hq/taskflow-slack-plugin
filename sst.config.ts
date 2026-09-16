/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "taskflow-slack-plugin",
      home: "cloudflare",
      removal: input?.stage === "prod" ? "retain" : "remove",
    };
  },
  async run() {
    const plugin = new sst.cloudflare.Worker("SlackPlugin", {
      handler: "src/index.ts",
      url: true,
      accountId: "89a9bc440d2181e5427417f4d92b761b",
      compatibility: {
        date: "2026-08-23",
        // Wrangler configured no flags; override SST's nodejs_compat default.
        flags: [],
      },
      environment: {
        TASKFLOW_ORIGIN: $app.stage === "prod"
          ? "https://mcp.flowbrew.app"
          : "https://mcp.staging.flowbrew.app",
      },
      transform: {
        worker: {
          // Preserve the existing Wrangler URLs and registered manifest endpoints.
          scriptName: $app.stage === "prod"
            ? "taskflow-slack-plugin"
            : `taskflow-slack-plugin-${$app.stage}`,
        },
      },
    });
    return { pluginUrl: plugin.url };
  },
});
