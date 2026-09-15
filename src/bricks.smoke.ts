import assert from "node:assert/strict";
import type { BrickHandlerContext } from "@flowbrew/plugin-sdk";

import {
  MINIMUM_SCOPES, slackBricks,
  authTestInputSchema, authTestOutputSchema, invokeSlackAuthTest,
  sendMessageInputSchema, sendMessageOutputSchema, invokeSlackSendMessage,
  listChannelsInputSchema, listChannelsOutputSchema, invokeSlackListChannels,
  readMessagesInputSchema, readMessagesOutputSchema, invokeSlackReadMessages,
  listUsersInputSchema, listUsersOutputSchema, invokeSlackListUsers,
} from "./bricks.js";
import worker, { createSlackWorker } from "./index.js";
import { createSlackPluginManifest } from "./manifest.js";
import { slackCall, sleep } from "./slack-api.js";

const token = "xoxb-synthetic-smoke-token";
const channel = "C12345678";
const ts = "1234567890.123456";
function context(): BrickHandlerContext {
  return {
    claims: {
      workspaceId: "workspace-a", projectId: "project-a", workflowId: "workflow-a",
      workflowInstanceId: "instance-a", brickId: "slack.slack-auth-test", resolutionId: "resolution-a",
      pluginVersionId: "plugin-version-a", connections: { slack: { connectionId: "connection-a", revision: 1 } },
      scope: ["brick:invoke"], timeoutMs: 30_000,
    },
    connections: { slack: { token } }, signal: new AbortController().signal,
    defer: async () => { throw new Error("No callback expected"); },
    registerCallback: async () => { throw new Error("No callback expected"); },
  };
}

function fakeSlack(method: string, expectedBody: unknown, result: unknown, headers?: HeadersInit): typeof fetch {
  return async (url, init) => {
    assert.equal(url.toString(), `https://slack.com/api/${method}`);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal instanceof AbortSignal);
    const sentHeaders = new Headers(init.headers);
    assert.equal(sentHeaders.get("authorization"), `Bearer ${token}`);
    const json = method === "chat.postMessage";
    assert.equal(sentHeaders.get("content-type"), json
      ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded; charset=utf-8");
    const body = await new Response(init.body).text();
    assert.deepEqual(json ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)), expectedBody);
    return Response.json(result, { headers });
  };
}

const authResponse = {
  ok: true, team_id: "T12345678", team: "Example", bot_id: "B12345678", user_id: "U12345678",
  url: "https://example.slack.com/",
};
const authExpected = {
  teamId: "T12345678", team: "Example", botUserId: "B12345678", userId: "U12345678",
  url: "https://example.slack.com/", scopes: [...MINIMUM_SCOPES], missingScopes: [],
};
const auth = await invokeSlackAuthTest({}, context(), fakeSlack("auth.test", {}, authResponse, {
  "X-OAuth-Scopes": " chat:write, channels:read,channels:history, users:read, ",
}));
assert.deepEqual(auth, authExpected);
authTestOutputSchema.parse(auth);
const advisory = await invokeSlackAuthTest({}, context(), fakeSlack("auth.test", {}, authResponse, {
  "X-OAuth-Scopes": "chat:write,users:read.email",
}));
assert.deepEqual(advisory.missingScopes, ["channels:read", "channels:history", "users:read"]);
assert.deepEqual((await invokeSlackAuthTest({}, context(), fakeSlack("auth.test", {}, authResponse))).missingScopes, MINIMUM_SCOPES);
const { bot_id: _botId, ...userTokenResponse } = authResponse;
await assert.rejects(invokeSlackAuthTest({}, context(), fakeSlack("auth.test", {}, userTokenResponse)), /bot_token_required.*bot_id/);
console.log("slack auth.test smoke OK");

const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Hello <@U123> — světe" } }];
const sendInput = sendMessageInputSchema.parse({ channel, text: "Hello — světe", threadTs: ts, replyBroadcast: true, blocks });
const sent = await invokeSlackSendMessage(sendInput, context(), fakeSlack("chat.postMessage", {
  channel, text: "Hello — světe", thread_ts: ts, reply_broadcast: true, blocks, unfurl_links: false, unfurl_media: false,
}, { ok: true, channel, ts, message: { text: "ignored" } }));
assert.deepEqual(sent, { channel, ts });
sendMessageOutputSchema.parse(sent);
assert.deepEqual(await invokeSlackSendMessage(sendMessageInputSchema.parse({ channel, text: "Hi" }), context(),
  fakeSlack("chat.postMessage", { channel, text: "Hi", unfurl_links: false, unfurl_media: false }, { ok: true, channel, ts })), { channel, ts });
console.log("slack chat.postMessage smoke OK");

const channelResponse = {
  ok: true, channels: [
    { id: channel, name: "general", is_private: false, is_archived: false, is_member: true, is_im: false,
      topic: { value: "Topic" }, purpose: { value: "Purpose" }, num_members: 0 },
    { id: "D12345678", is_im: true, is_private: true },
  ], response_metadata: { next_cursor: " next+/= " },
};
const channels = await invokeSlackListChannels(listChannelsInputSchema.parse({}), context(), fakeSlack("conversations.list", {
  types: "public_channel", exclude_archived: "true", limit: "200",
}, channelResponse));
assert.deepEqual(channels, {
  channels: [
    { id: channel, name: "general", isPrivate: false, isArchived: false, isMember: true, isIm: false,
      topic: "Topic", purpose: "Purpose", numMembers: 0 },
    { id: "D12345678", name: "", isPrivate: true, isArchived: false, isMember: false, isIm: true,
      topic: "", purpose: "", numMembers: null },
  ], nextCursor: "next+/=",
});
listChannelsOutputSchema.parse(channels);
assert.deepEqual(await invokeSlackListChannels(listChannelsInputSchema.parse({
  types: ["private_channel", "mpim", "im"], excludeArchived: false, limit: 1000, cursor: "next+/=",
}), context(), fakeSlack("conversations.list", {
  types: "private_channel,mpim,im", exclude_archived: "false", limit: "1000", cursor: "next+/=",
}, { ok: true, channels: [], response_metadata: { next_cursor: "" } })), { channels: [], nextCursor: null });
console.log("slack conversations.list smoke OK");

const messageResponse = {
  ok: true, messages: [
    { ts, thread_ts: ts, user: "U12345678", bot_id: "B12345678", subtype: "bot_message", text: "<@U123> hello",
      reply_count: 0, edited: { user: "U12345678", ts }, reactions: [{ name: "wave", count: 2, users: ["U12345678"] }],
      files: [{ id: "F12345678", name: "hello.txt", mimetype: "text/plain", size: 0,
        url_private: "https://files.slack.com/private", url_private_download: "https://files.slack.com/download" }, { id: "F87654321" }] },
    { ts: "1234567890.123455" },
  ], has_more: true, response_metadata: { next_cursor: "messages-next" },
};
const messages = await invokeSlackReadMessages(readMessagesInputSchema.parse({ channel }), context(), fakeSlack("conversations.history", {
  channel, limit: "100",
}, messageResponse));
assert.deepEqual(messages, {
  messages: [
    { ts, threadTs: ts, userId: "U12345678", botId: "B12345678", subtype: "bot_message", text: "<@U123> hello",
      replyCount: 0, edited: true, reactions: [{ name: "wave", count: 2 }],
      files: [{ id: "F12345678", name: "hello.txt", mimetype: "text/plain", size: 0 },
        { id: "F87654321", name: null, mimetype: null, size: null }] },
    { ts: "1234567890.123455", threadTs: null, userId: null, botId: null, subtype: null, text: "",
      replyCount: null, edited: false, reactions: [], files: [] },
  ], hasMore: true, nextCursor: "messages-next",
});
readMessagesOutputSchema.parse(messages);
assert.ok(!JSON.stringify(messages).includes("files.slack.com"));
assert.deepEqual(await invokeSlackReadMessages(readMessagesInputSchema.parse({
  channel, threadTs: ts, limit: 25, cursor: "messages-next", oldest: "1234560000.000000", latest: ts, inclusive: false,
}), context(), fakeSlack("conversations.replies", {
  channel, ts, limit: "25", cursor: "messages-next", oldest: "1234560000.000000", latest: ts, inclusive: "false",
}, { ok: true, messages: [{ ts, text: "Parent" }, { ts: "1234567891.000000", text: "Reply" }], has_more: false })), {
  messages: [ts, "1234567891.000000"].map((messageTs, index) => ({
    ts: messageTs, threadTs: null, userId: null, botId: null, subtype: null, text: index === 0 ? "Parent" : "Reply",
    replyCount: null, edited: false, reactions: [], files: [],
  })), hasMore: false, nextCursor: null,
});
console.log("slack conversations.history/replies smoke OK");

const userResponse = {
  ok: true, members: [
    { id: "U12345678", name: "alice", real_name: "Alice", profile: { display_name: "Al", email: "alice@example.test" },
      is_bot: false, is_admin: false, deleted: false, tz: "Europe/Prague" },
    { id: "U23456789", name: "bob" },
    { id: "U34567890", name: "deleted", deleted: true },
    { id: "U45678901", name: "bot", is_bot: true },
    { id: "U56789012", name: "deleted-bot", deleted: true, is_bot: true },
    { id: "USLACKBOT", name: "slackbot", is_bot: false },
  ], response_metadata: { next_cursor: "users-next" },
};
const users = await invokeSlackListUsers(listUsersInputSchema.parse({}), context(), fakeSlack("users.list", { limit: "200" }, userResponse));
assert.deepEqual(users, {
  users: [
    { id: "U12345678", name: "alice", realName: "Alice", displayName: "Al", email: "alice@example.test",
      isBot: false, isAdmin: false, deleted: false, tz: "Europe/Prague" },
    { id: "U23456789", name: "bob", realName: null, displayName: null, email: null,
      isBot: false, isAdmin: null, deleted: false, tz: null },
  ], nextCursor: "users-next",
});
listUsersOutputSchema.parse(users);
for (const [includeDeleted, includeBots, expectedIds] of [
  [true, false, ["U12345678", "U23456789", "U34567890"]],
  [false, true, ["U12345678", "U23456789", "U45678901"]],
  [true, true, ["U12345678", "U23456789", "U34567890", "U45678901", "U56789012"]],
] as const) {
  const page = await invokeSlackListUsers(listUsersInputSchema.parse({ includeDeleted, includeBots, cursor: "users-next", limit: 5 }),
    context(), fakeSlack("users.list", { limit: "5", cursor: "users-next" }, userResponse));
  assert.deepEqual(page.users.map((user) => user.id), expectedIds);
  assert.equal(page.nextCursor, "users-next");
}
assert.deepEqual(await invokeSlackListUsers(listUsersInputSchema.parse({}), context(), fakeSlack("users.list", { limit: "200" }, {
  ok: true, members: userResponse.members.slice(2), response_metadata: { next_cursor: "still-more" },
})), { users: [], nextCursor: "still-more" });
console.log("slack users.list smoke OK");

const invocations = [
  (fetchImpl: typeof fetch, ctx = context()) => invokeSlackAuthTest({}, ctx, fetchImpl),
  (fetchImpl: typeof fetch, ctx = context()) => invokeSlackSendMessage(sendMessageInputSchema.parse({ channel, text: "Hi" }), ctx, fetchImpl),
  (fetchImpl: typeof fetch, ctx = context()) => invokeSlackListChannels(listChannelsInputSchema.parse({}), ctx, fetchImpl),
  (fetchImpl: typeof fetch, ctx = context()) => invokeSlackReadMessages(readMessagesInputSchema.parse({ channel }), ctx, fetchImpl),
  (fetchImpl: typeof fetch, ctx = context()) => invokeSlackListUsers(listUsersInputSchema.parse({}), ctx, fetchImpl),
];
for (const invoke of invocations) {
  let calls = 0;
  await assert.rejects(invoke(async () => {
    calls += 1;
    return Response.json({ ok: false, error: "channel_not_found" }, { status: 200 });
  }), /channel_not_found/);
  assert.equal(calls, 1);
  await assert.rejects(invoke(async () => { throw new Error("Unexpected fetch"); }, { ...context(), connections: {} }), /missing_connection/);
}
assert.equal((await slackCall("auth.test", token, {}, {
  fetchImpl: async () => Response.json({ ok: true }, { status: 503 }),
})).data.ok, true, "Slack's ok field, not HTTP success, determines the result");
await assert.rejects(slackCall("auth.test", token, {}, { fetchImpl: async () => Response.json({}) }));
let networkCalls = 0;
await assert.rejects(slackCall("chat.postMessage", token, {}, { fetchImpl: async () => {
  networkCalls += 1;
  throw new Error("network unavailable");
} }), /network unavailable/);
assert.equal(networkCalls, 1);
console.log("slack error branching smoke OK");

let retryCalls = 0;
let clock = 0;
const waits: number[] = [];
const retryBodies: string[] = [];
await slackCall("chat.postMessage", token, { channel, text: "Hi", blocks }, {
  json: true, now: () => clock,
  sleepImpl: async (milliseconds, signal) => { assert.equal(signal.aborted, false); waits.push(milliseconds); clock += milliseconds; },
  fetchImpl: async (_url, init) => {
    retryBodies.push(await new Response(init?.body).text());
    retryCalls += 1;
    return retryCalls === 1
      ? new Response("rate limit, not JSON", { status: 429, headers: { "Retry-After": "2" } })
      : Response.json({ ok: true });
  },
});
assert.equal(retryCalls, 2);
assert.deepEqual(waits, [2000]);
assert.equal(retryBodies[0], retryBodies[1]);
for (const retryAfter of [null, "", "invalid", "-1", "Infinity", "0.5", "16", "999999999999999999999"]) {
  let calls = 0;
  await assert.rejects(slackCall("users.list", token, {}, {
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 429, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } }); },
    sleepImpl: async () => { assert.fail("Must not sleep outside budget"); },
  }), /^Error: slack:ratelimited/);
  assert.equal(calls, 1);
}
let repeatedCalls = 0;
let repeatedWaits = 0;
await assert.rejects(slackCall("users.list", token, {}, {
  fetchImpl: async () => { repeatedCalls += 1; return new Response(null, { status: 429, headers: { "Retry-After": "0" } }); },
  sleepImpl: async () => { repeatedWaits += 1; },
}), /^Error: slack:ratelimited/);
assert.equal(repeatedCalls, 2);
assert.equal(repeatedWaits, 1);
clock = 0;
await assert.rejects(slackCall("users.list", token, {}, {
  now: () => clock,
  fetchImpl: async () => { clock = 6000; return new Response(null, { status: 429, headers: { "Retry-After": "10" } }); },
  sleepImpl: async () => { assert.fail("Elapsed time must count against budget"); },
}), /^Error: slack:ratelimited/);
const abort = new AbortController();
const pendingSleep = sleep(10_000, abort.signal);
abort.abort(new Error("cancelled"));
await assert.rejects(pendingSleep, /cancelled/);
await assert.rejects(slackCall("users.list", token, {}, {
  signal: abort.signal, fetchImpl: async () => { assert.fail("Aborted calls must not fetch"); },
}), /cancelled/);
await sleep(0, new AbortController().signal);
console.log("slack rate-limit budget and cancellation smoke OK");

const baseUrl = "https://slack-plugin.example.test";
const manifest = createSlackPluginManifest(`${baseUrl}/`);
assert.equal(manifest.slug, "slack");
assert.equal(manifest.version, "1.0.0");
assert.deepEqual(manifest.triggers, []);
assert.equal(manifest.connectionTypes.length, 1);
assert.equal(manifest.connectionTypes[0]?.key, "slack");
assert.equal(manifest.connectionTypes[0]?.validationBrick, "slack-auth-test");
assert.deepEqual(manifest.connectionTypes[0]?.credentialSchema.required, ["token"]);
const expectedSlugs = ["slack-auth-test", "slack-send-message", "slack-list-channels", "slack-read-messages", "slack-list-users"];
assert.deepEqual(manifest.bricks.map((brick) => brick.slug), expectedSlugs);
for (const brick of manifest.bricks) {
  assert.equal(brick.endpointUrl, `${baseUrl}/bricks/${brick.slug}`);
  assert.deepEqual(brick.connections, { slack: { typeKey: "slack", required: true } });
  assert.equal(brick.callback, undefined);
  assert.deepEqual(brick.retries, brick.slug === "slack-send-message" ? { limit: 0 } : undefined);
  assert.equal(brick.inputSchema.additionalProperties, false);
  assert.equal(brick.outputSchema.additionalProperties, false);
}
for (const brick of slackBricks(baseUrl)) {
  assert.equal(brick.input.safeParse({ unexpected: true }).success, false);
}
assert.equal(authTestInputSchema.safeParse({ token }).success, false);
for (const bad of [{ channel: "general", text: "Hi" }, { channel, text: "" }, { channel, text: "x".repeat(40001) },
  { channel, text: "Hi", threadTs: "bad" }, { channel, text: "Hi", blocks: Array(51).fill({}) }]) {
  assert.equal(sendMessageInputSchema.safeParse(bad).success, false);
}
assert.equal(sendMessageInputSchema.safeParse({ channel, text: "x".repeat(40000), blocks: Array(50).fill({}) }).success, true);
assert.equal(listChannelsInputSchema.safeParse({ types: [] }).success, false);
assert.equal(listChannelsInputSchema.safeParse({ limit: 1001 }).success, false);
assert.equal(readMessagesInputSchema.safeParse({ channel, limit: 0 }).success, false);
assert.equal(listUsersInputSchema.safeParse({ limit: 201 }).success, false);
assert.equal(listUsersInputSchema.safeParse({ limit: 1.5 }).success, false);
assert.equal(createSlackPluginManifest("https://other.example.test").bricks[0]?.endpointUrl,
  "https://other.example.test/bricks/slack-auth-test");
assert.throws(() => createSlackWorker(baseUrl, ""));
const routedWorker = createSlackWorker(baseUrl, "https://platform.example.test");
for (const brick of manifest.bricks) {
  assert.equal((await routedWorker.fetch(new Request(brick.endpointUrl))).status, 405);
  assert.equal((await routedWorker.fetch(new Request(brick.endpointUrl, { method: "POST" }))).status, 401);
}
assert.equal((await routedWorker.fetch(new Request(`${baseUrl}/unknown`))).status, 404);
console.log("slack schemas, manifest and route guards smoke OK");

// Exercise the real SDK: ES256 verification, discovery, redemption and Bearer translation.
const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
assert.ok("publicKey" in keys && "privateKey" in keys);
const signingKey = keys.privateKey;
const publicKey = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "smoke-key", alg: "ES256" };
const origin = "https://platform.example.test";
const issuer = "https://auth.example.test";
const originalFetch = globalThis.fetch;
let discoveries = 0;
let jwksRequests = 0;
let redemptions = 0;
let slackRequests = 0;
async function signedToken(slug: string) {
  const now = Math.floor(Date.now() / 1000);
  const encoded = [
    { alg: "ES256", kid: "smoke-key" },
    { ...context().claims, brickId: `slack.${slug}`, iss: issuer, aud: "taskflow:brick", iat: now, exp: now + 60 },
  ].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, new TextEncoder().encode(encoded));
  return `${encoded}.${Buffer.from(signature).toString("base64url")}`;
}
try {
  globalThis.fetch = async (url, init) => {
    const address = url.toString();
    if (address === `${origin}/.well-known/flowbrew-plugin-configuration`) {
      discoveries += 1;
      return Response.json({ issuer, jwksUrl: `${issuer}/jwks`, redemptionUrl: `${issuer}/redeem` });
    }
    if (address === `${issuer}/jwks`) {
      jwksRequests += 1;
      return Response.json({ keys: [publicKey] });
    }
    if (address === `${issuer}/redeem`) {
      redemptions += 1;
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      assert.deepEqual(JSON.parse(String(init?.body)), { slotName: "slack" });
      assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer ey/);
      return Response.json({ credentials: { token }, config: null });
    }
    slackRequests += 1;
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    const result = address.endsWith("/auth.test") ? authResponse
      : address.endsWith("/chat.postMessage") ? { ok: true, channel, ts }
      : address.endsWith("/conversations.list") ? { ok: true, channels: [] }
      : address.endsWith("/conversations.history") ? { ok: true, messages: [] }
      : address.endsWith("/users.list") ? { ok: true, members: [] }
      : assert.fail(`Unexpected URL: ${address}`);
    return Response.json(result);
  };
  for (const slug of expectedSlugs) {
    const input = slug === "slack-send-message" ? { channel, text: "Hi" }
      : slug === "slack-read-messages" ? { channel } : {};
    const response = await worker.fetch(new Request(`${baseUrl}/bricks/${slug}`, {
      method: "POST", headers: { authorization: `Bearer ${await signedToken(slug)}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    }), { TASKFLOW_ORIGIN: origin });
    assert.equal(response.status, 200, await response.clone().text());
    const authored = slackBricks(baseUrl).find((brick) => brick.slug === slug)!;
    authored.output.parse(await response.json());
  }
  assert.equal(discoveries, 5);
  assert.equal(jwksRequests, 5);
  assert.equal(redemptions, 5);
  assert.equal(slackRequests, 5);

  // A second invocation through the deployed entry point must reuse the SDK caches.
  const repeated = await worker.fetch(new Request(`${baseUrl}/bricks/slack-auth-test`, {
    method: "POST", headers: { authorization: `Bearer ${await signedToken("slack-auth-test")}`, "content-type": "application/json" },
    body: "{}",
  }), { TASKFLOW_ORIGIN: origin });
  assert.equal(repeated.status, 200, await repeated.clone().text());
  assert.deepEqual(await repeated.json(), { ...authExpected, scopes: [], missingScopes: [...MINIMUM_SCOPES] });
  assert.equal(discoveries, 5, "Repeated invocations must reuse discovery configuration");
  assert.equal(jwksRequests, 5, "Repeated invocations must reuse JWKS");
  assert.equal(redemptions, 6);
  assert.equal(slackRequests, 6);
  const wrongBrick = await worker.fetch(new Request(`${baseUrl}/bricks/slack-list-users`, {
    method: "POST", headers: { authorization: `Bearer ${await signedToken("slack-auth-test")}` }, body: "{}",
  }), { TASKFLOW_ORIGIN: origin });
  assert.equal(wrongBrick.status, 401);
  const invalidInput = await worker.fetch(new Request(`${baseUrl}/bricks/slack-auth-test`, {
    method: "POST", headers: { authorization: `Bearer ${await signedToken("slack-auth-test")}` }, body: JSON.stringify({ token }),
  }), { TASKFLOW_ORIGIN: origin });
  assert.equal(invalidInput.status, 400);
  assert.equal(redemptions, 6);
  assert.equal(slackRequests, 6);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("slack SDK signed invocation and connection redemption smoke OK");
console.log("All 5 Slack bricks smoke OK");
