# Taskflow Slack plugin

Standalone Taskflow plugin `slack` v1, deployed as a Cloudflare Worker using the
published `@flowbrew/plugin-sdk`. It provides four Slack actions and one connection
validation brick.

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

Node.js 22 and npm:

```sh
npm ci
npm run check
npm test
```

Tests are framework-free `node:assert/strict` smoke tests run with `tsx`. They call
the exported handlers with fake Slack responses and inspect request bodies,
headers, normalization, errors, pagination and rate limiting. They also validate
the generated manifest and exercise real SDK signing verification and credential
redemption against fake endpoints. They require no live Slack credentials.

## Configuration and manual deployment

`wrangler.toml` sets `TASKFLOW_ORIGIN` to `https://mcp.staging.flowbrew.app`.
SDK 0.2.1 discovers issuer, JWKS and redemption URLs from
`<TASKFLOW_ORIGIN>/.well-known/flowbrew-plugin-configuration`. Unlike the older PoC,
it accepts `origin`, not direct `issuer` / `jwksUrl` handler options. Staging's
issuer is `https://auth.staging.flowbrew.app` and its JWKS URL is
`https://auth.staging.flowbrew.app/.well-known/taskflow-brick-jwks.json`.
Set `TASKFLOW_ORIGIN` to the target platform for another environment; there is no
fallback if the binding is absent. Never configure Slack tokens as Worker vars.

```sh
npm run deploy:staging
# Another environment (set both the Worker name and platform origin):
npx wrangler deploy --name taskflow-slack-plugin --var TASKFLOW_ORIGIN:https://mcp.flowbrew.app
```

Generate the uploadable manifest with the deployed Worker's actual base URL:

```sh
npx tsx --eval 'import { createSlackPluginManifest } from "./src/manifest.ts"; console.log(JSON.stringify(createSlackPluginManifest("https://your-worker.example.com"), null, 2))'
```

Only the serializable manifest is uploaded; the Worker retains the connection
translator via `createSlackPlugin(baseUrl)`. Each brick is served at
`/bricks/<slug>`, matching its manifest endpoint. The manifest defaults to private
visibility. Deployment and platform upload remain manual future steps.

## Approvals and deliberate v1 exclusions

For approvals, compose the existing `core.create-approval-gate` brick with
`slack.slack-send-message`: put the gate's returned `url` in a URL button inside a
Block Kit actions block, then use the existing `core.await-approval` brick. Those
core bricks live in the platform and are not implemented here.

V1 includes no Slack interactivity endpoint, signing-secret storage, button-click
handling, dedicated approval brick, or file downloading. There is no Cloudflare
rate-limiter binding. CI runs only install, typecheck and smoke tests: no deploy,
`/plugins/upload`, or live end-to-end wiring.
