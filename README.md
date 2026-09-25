# Taskflow Slack plugin

Standalone Taskflow plugin `slack` v1, deployed as a Cloudflare Worker using the
published `@flowbrew/plugin-sdk` 0.4.x and SST for deployment. It provides four
Slack actions and one connection validation brick.

| Brick | Slack API / purpose |
| --- | --- |
| `slack.slack-auth-test` | `auth.test`: validate a bot token and report granted/missing scopes |
| `slack.slack-send-message` | `chat.postMessage`: post mrkdwn or Block Kit to a channel, DM or thread |
| `slack.slack-list-channels` | `conversations.list`: list one page of conversations |
| `slack.slack-read-messages` | `conversations.history` / `conversations.replies`: read one page |
| `slack.slack-list-users` | `users.list`: list one page, optionally including deleted users/bots |

Every brick requires the `slack` connection, a `BearerConnection` named **Slack bot
token**. Credentials are redeemed into `context.connections.slack.token`, never
workflow input. Validation rejects Slack errors and tokens without `bot_id`.
`botUserId` maps to Slack's `bot_id` (B…); `userId` maps to `user_id` (U…).
Missing `chat:write`, `channels:read`, `channels:history` or `users:read` scopes are
advisory in `missingScopes`. Email can be null without `users:read.email`.

Follow `nextCursor` until null, even for empty/short pages. User filtering happens
client-side; `USLACKBOT` is always excluded. File results contain metadata only.

All Slack requests use POST with manual redirects: form bodies for reads/auth,
JSON for posting messages. Slack `{ ok: false }` responses throw, even at HTTP 200.
A 429 can retry once after `Retry-After` if elapsed time plus the wait fits within
15 seconds of a 20-second call budget, leaving at least 5 seconds for the retry.
Otherwise the error starts with `slack:ratelimited`. Network/Slack API errors are
not retried internally. Platform retries are disabled for send-message because
repeating a successful post creates a duplicate.

## Development

**SDK version pin:** `@flowbrew/plugin-sdk` is pinned to an exact version on purpose.
Check the SDK CHANGELOG before bumping it: pre-1.0 minor releases can contain
breaking changes (e.g. 0.5.0 changed the manifest pointer scheme from `https://`
to `fetch://`).

Node.js 22.12+ and npm:

```sh
npm ci
npm run check
npm test
```

Tests use Vitest in the Node environment; `npm test` runs once for CI. The
`src/**/*.test.ts` files contain separate `describe`/`it` cases, so a failing test
does not prevent later tests from running. They call
the exported handlers with fake Slack responses and inspect request bodies,
headers, normalization, errors, pagination and rate limiting. They also validate
the generated manifest and exercise real SDK signing verification and credential
redemption against fake endpoints. They require no live Slack credentials.

Export CI results with Vitest's built-in reporters, for example:

```sh
npm test -- --reporter=junit --outputFile=/tmp/slack-tests.xml
npm test -- --reporter=json --outputFile=/tmp/slack-tests.json
```

## Configuration and deployment

`sst.config.ts` defines one ordinary Cloudflare Worker with a `TASKFLOW_ORIGIN`
string binding: `https://mcp.staging.flowbrew.app` by default, or
`https://mcp.flowbrew.app` for stage `prod`. It preserves compatibility date
`2026-08-23` and no compatibility flags. There are no plugin KV, R2, Durable
Object, or service bindings.

The SDK discovers issuer, JWKS and redemption URLs from
`<TASKFLOW_ORIGIN>/.well-known/flowbrew-plugin-configuration`. The handler accepts
`origin`, not direct `issuer` / `jwksUrl` options. Set `TASKFLOW_ORIGIN` to the
target platform for another environment; there is no fallback if the binding is
absent. Never configure Slack tokens as Worker vars.

SST uses `home: "cloudflare"`, so state stays in the dedicated Taskflow Cloudflare
account (`89a9bc440d2181e5427417f4d92b761b`). SST 4.17.1 automatically manages an
`sst-state` R2 bucket for its own state; no Pulumi Cloud account or separate S3
backend is needed. SST manages this backend independently of the plugin bindings.
Production uses `removal: "retain"` to retain the Worker on removal.

### CI deployment and registration

- Pushes to `main` deploy stage `staging`; `v*` tag pushes deploy stage `prod`.
- Both deploy workflows run Vitest before deploying, then publish the public
  Slack manifest to that stage's `/plugins/upload` endpoint.
- `PLUGIN_BASE_URL` comes from the deployed `pluginUrl` in `.sst/outputs.json`.
  Explicit Worker script names preserve the existing endpoints:
  `https://taskflow-slack-plugin-staging.taskflow-app.workers.dev` and
  `https://taskflow-slack-plugin.taskflow-app.workers.dev`.
- The workflows use Node/npm and GitHub-hosted `ubuntu-latest` runners; Bun is
  not required. The separate `ci.yml` runs install, typecheck and Vitest on
  pushes and pull requests, without deployment or registration.

Set these repository Actions secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | SST deployment and Cloudflare state access |
| `CLOUDFLARE_DEFAULT_ACCOUNT_ID` | Dedicated Taskflow account ID above; SST reads this exact variable |
| `STAGING_SLACK_PLUGIN_API_KEY` | Staging manifest upload; requires `plugins:publish:public` |
| `PROD_SLACK_PLUGIN_API_KEY` | Production manifest upload; requires `plugins:publish:public` |

The first SST deployment must be supervised by JARVIS/Jakub, including the
transition of the existing Worker into SST management. Coordinate the merge:
pushing the merge to `main` starts the staging deploy workflow. This migration
is validated locally without deploying or uploading a manifest.

### Maintainer commands

These commands change real infrastructure; use them only for an intended deploy
with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_DEFAULT_ACCOUNT_ID` configured:

```sh
npm run deploy -- --stage staging
npm run deploy -- --stage prod
```

For an intended manual registration after deployment, set `SLACK_PLUGIN_API_KEY`
to the target stage's publishing key and use the output from that same deploy:

```sh
export PLUGIN_BASE_URL="$(node -p 'require("./.sst/outputs.json").pluginUrl')"
export MCP_ORIGIN=https://mcp.staging.flowbrew.app # https://mcp.flowbrew.app for prod
npm run publish-manifest
```

The script trims and validates `SLACK_PLUGIN_API_KEY`, `PLUGIN_BASE_URL` and
`MCP_ORIGIN`, builds the manifest, and delegates uploading to the SDK's
`uploadPluginManifest`. The SDK handles the 60-second timeout, rejected redirects,
response validation and version-conflict hints. It returns the unwrapped plugin
summary. Tests here cover configuration, manifest construction and CLI output;
the SDK's own suite covers upload protocol behavior.

Only the serializable manifest is uploaded; the Worker retains the connection
translator via `createSlackPlugin(baseUrl)`. Each brick is served at
`/bricks/<slug>`, matching its manifest endpoint. The manifest has **public**
visibility. New uploads and byte-identical reuploads both succeed. Changes to
bricks, schemas or endpoint URLs require a bump to `SLACK_PLUGIN_VERSION` in
`src/manifest.ts`; a release tag alone does not change the manifest version.

To inspect a manifest locally without uploading it:

```sh
npx tsx --eval 'import { createSlackPluginManifest } from "./src/manifest.ts"; console.log(JSON.stringify(createSlackPluginManifest("https://your-worker.example.com"), null, 2))'
```

## For external plugin authors

This repo uses SST for consistency with Taskflow's other deployments. The
underlying deployable unit is a completely ordinary Cloudflare Worker, and the
Taskflow plugin protocol does not require SST. Wrangler is a valid, simpler
alternative for your own plugin.

To use the pre-migration deployment path, create this minimal `wrangler.toml` in
your own project (the same configuration this repo previously used):

```toml
main = "src/index.ts"
compatibility_date = "2026-08-23"
workers_dev = true

[vars]
TASKFLOW_ORIGIN = "https://mcp.staging.flowbrew.app"
```

After authenticating Wrangler to **your own Cloudflare account**, the original
commands are:

```sh
npx wrangler deploy --name taskflow-slack-plugin-staging
npx wrangler deploy --name taskflow-slack-plugin --var TASKFLOW_ORIGIN:https://mcp.flowbrew.app
```

Choose your own Worker names and platform origin as needed. Use the URL Wrangler
prints as `PLUGIN_BASE_URL` for manifest registration; the publishing script above
works with either deploy tool. For a new plugin, define your own manifest slug,
version, bricks and connection types. Use one deploy tool to manage a given Worker;
the Taskflow-maintained Workers in this repo are managed by SST.

## Approvals and deliberate v1 exclusions

For approvals, compose the existing `core.create-approval-gate` brick with
`slack.slack-send-message`: put the gate's returned `url` in a URL button inside a
Block Kit actions block, then use the existing `core.await-approval` brick. Those
core bricks live in the platform and are not implemented here.

V1 includes no Slack interactivity endpoint, signing-secret storage, button-click
handling, dedicated approval brick, or file downloading. There is no Cloudflare
rate-limiter binding. CI deploys and registers the plugin as described above;
live Slack end-to-end testing remains a separate, supervised step.
