import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrickHandlerContext } from "@flowbrew/plugin-sdk";

import {
  MINIMUM_SCOPES, slackBricks,
  authTestInputSchema, authTestOutputSchema, invokeSlackAuthTest,
  sendMessageInputSchema, sendMessageOutputSchema, invokeSlackSendMessage,
  listChannelsInputSchema, listChannelsOutputSchema, invokeSlackListChannels,
  readMessagesInputSchema, readMessagesOutputSchema, invokeSlackReadMessages,
  listUsersInputSchema, listUsersOutputSchema, invokeSlackListUsers,
} from "./bricks.js";
import { createSlackWorker } from "./index.js";
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
    expect(url.toString()).toBe(`https://slack.com/api/${method}`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal instanceof AbortSignal).toBeTruthy();
    const sentHeaders = new Headers(init?.headers);
    expect(sentHeaders.get("authorization")).toBe(`Bearer ${token}`);
    const json = method === "chat.postMessage";
    expect(sentHeaders.get("content-type")).toBe(json
      ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded; charset=utf-8");
    const body = await new Response(init?.body).text();
    expect(json ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body))).toEqual(expectedBody);
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

const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Hello <@U123> — světe" } }];

const channelResponse = {
  ok: true, channels: [
    { id: channel, name: "general", is_private: false, is_archived: false, is_member: true, is_im: false,
      topic: { value: "Topic" }, purpose: { value: "Purpose" }, num_members: 0 },
    { id: "D12345678", is_im: true, is_private: true },
  ], response_metadata: { next_cursor: " next+/= " },
};

const messageResponse = {
  ok: true, messages: [
    { ts, thread_ts: ts, user: "U12345678", bot_id: "B12345678", subtype: "bot_message", text: "<@U123> hello",
      reply_count: 0, edited: { user: "U12345678", ts }, reactions: [{ name: "wave", count: 2, users: ["U12345678"] }],
      files: [{ id: "F12345678", name: "hello.txt", mimetype: "text/plain", size: 0,
        url_private: "https://files.slack.com/private", url_private_download: "https://files.slack.com/download" }, { id: "F87654321" }] },
    { ts: "1234567890.123455" },
  ], has_more: true, response_metadata: { next_cursor: "messages-next" },
};

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

const invocations = [
  (fetchImpl: typeof fetch, ctx = context()) => invokeSlackAuthTest({}, ctx, fetchImpl),
  (fetchImpl: typeof fetch, ctx = context()) => invokeSlackSendMessage(sendMessageInputSchema.parse({ channel, text: "Hi" }), ctx, fetchImpl),
  (fetchImpl: typeof fetch, ctx = context()) => invokeSlackListChannels(listChannelsInputSchema.parse({}), ctx, fetchImpl),
  (fetchImpl: typeof fetch, ctx = context()) => invokeSlackReadMessages(readMessagesInputSchema.parse({ channel }), ctx, fetchImpl),
  (fetchImpl: typeof fetch, ctx = context()) => invokeSlackListUsers(listUsersInputSchema.parse({}), ctx, fetchImpl),
];

const baseUrl = "https://slack-plugin.example.test";
const manifest = createSlackPluginManifest(`${baseUrl}/`);

const expectedSlugs = ["slack-auth-test", "slack-send-message", "slack-list-channels", "slack-read-messages", "slack-list-users"];

describe("auth.test", () => {
  it("normalizes bot identity and granted scopes", async () => {
    const auth = await invokeSlackAuthTest({}, context(), fakeSlack("auth.test", {}, authResponse, {
      "X-OAuth-Scopes": " chat:write, channels:read,channels:history, users:read, ",
    }));
    expect(auth).toEqual(authExpected);
    authTestOutputSchema.parse(auth);
  });

  it("reports missing scopes as advisory", async () => {
    const advisory = await invokeSlackAuthTest({}, context(), fakeSlack("auth.test", {}, authResponse, {
      "X-OAuth-Scopes": "chat:write,users:read.email",
    }));
    expect(advisory.missingScopes).toEqual(["channels:read", "channels:history", "users:read"]);
  });

  it("reports all minimum scopes when headers are absent", async () => {
    expect((await invokeSlackAuthTest({}, context(), fakeSlack("auth.test", {}, authResponse))).missingScopes).toEqual(MINIMUM_SCOPES);
  });

  it("rejects user tokens without bot_id", async () => {
    const { bot_id: _botId, ...userTokenResponse } = authResponse;
    await expect(invokeSlackAuthTest({}, context(), fakeSlack("auth.test", {}, userTokenResponse))).rejects.toThrow(/bot_token_required.*bot_id/);
  });
});

describe("chat.postMessage", () => {
  it("posts Unicode text, blocks and thread options", async () => {
    const sendInput = sendMessageInputSchema.parse({ channel, text: "Hello — světe", threadTs: ts, replyBroadcast: true, blocks });
    const sent = await invokeSlackSendMessage(sendInput, context(), fakeSlack("chat.postMessage", {
      channel, text: "Hello — světe", thread_ts: ts, reply_broadcast: true, blocks, unfurl_links: false, unfurl_media: false,
    }, { ok: true, channel, ts, message: { text: "ignored" } }));
    expect(sent).toEqual({ channel, ts });
    sendMessageOutputSchema.parse(sent);
  });

  it("posts a simple message with unfurls disabled", async () => {
    expect(await invokeSlackSendMessage(sendMessageInputSchema.parse({ channel, text: "Hi" }), context(),
      fakeSlack("chat.postMessage", { channel, text: "Hi", unfurl_links: false, unfurl_media: false }, { ok: true, channel, ts }))).toEqual({ channel, ts });
  });
});

describe("conversations.list", () => {
  it("normalizes channels and trims pagination cursors", async () => {
    const channels = await invokeSlackListChannels(listChannelsInputSchema.parse({}), context(), fakeSlack("conversations.list", {
      types: "public_channel", exclude_archived: "true", limit: "200",
    }, channelResponse));
    expect(channels).toEqual({
      channels: [
        { id: channel, name: "general", isPrivate: false, isArchived: false, isMember: true, isIm: false,
          topic: "Topic", purpose: "Purpose", numMembers: 0 },
        { id: "D12345678", name: "", isPrivate: true, isArchived: false, isMember: false, isIm: true,
          topic: "", purpose: "", numMembers: null },
      ], nextCursor: "next+/=",
    });
    listChannelsOutputSchema.parse(channels);
  });

  it("forwards filters and normalizes an empty final page", async () => {
    expect(await invokeSlackListChannels(listChannelsInputSchema.parse({
      types: ["private_channel", "mpim", "im"], excludeArchived: false, limit: 1000, cursor: "next+/=",
    }), context(), fakeSlack("conversations.list", {
      types: "private_channel,mpim,im", exclude_archived: "false", limit: "1000", cursor: "next+/=",
    }, { ok: true, channels: [], response_metadata: { next_cursor: "" } }))).toEqual({ channels: [], nextCursor: null });
  });
});

describe("conversations.history/replies", () => {
  it("normalizes history and excludes private file URLs", async () => {
    const messages = await invokeSlackReadMessages(readMessagesInputSchema.parse({ channel }), context(), fakeSlack("conversations.history", {
      channel, limit: "100",
    }, messageResponse));
    expect(messages).toEqual({
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
    expect(!JSON.stringify(messages).includes("files.slack.com")).toBeTruthy();
  });

  it("forwards thread and time filters and normalizes replies", async () => {
    expect(await invokeSlackReadMessages(readMessagesInputSchema.parse({
      channel, threadTs: ts, limit: 25, cursor: "messages-next", oldest: "1234560000.000000", latest: ts, inclusive: false,
    }), context(), fakeSlack("conversations.replies", {
      channel, ts, limit: "25", cursor: "messages-next", oldest: "1234560000.000000", latest: ts, inclusive: "false",
    }, { ok: true, messages: [{ ts, text: "Parent" }, { ts: "1234567891.000000", text: "Reply" }], has_more: false }))).toEqual({
      messages: [ts, "1234567891.000000"].map((messageTs, index) => ({
        ts: messageTs, threadTs: null, userId: null, botId: null, subtype: null, text: index === 0 ? "Parent" : "Reply",
        replyCount: null, edited: false, reactions: [], files: [],
      })), hasMore: false, nextCursor: null,
    });
  });
});

describe("users.list", () => {
  it("normalizes profiles and excludes deleted users and bots by default", async () => {
    const users = await invokeSlackListUsers(listUsersInputSchema.parse({}), context(), fakeSlack("users.list", { limit: "200" }, userResponse));
    expect(users).toEqual({
      users: [
        { id: "U12345678", name: "alice", realName: "Alice", displayName: "Al", email: "alice@example.test",
          isBot: false, isAdmin: false, deleted: false, tz: "Europe/Prague" },
        { id: "U23456789", name: "bob", realName: null, displayName: null, email: null,
          isBot: false, isAdmin: null, deleted: false, tz: null },
      ], nextCursor: "users-next",
    });
    listUsersOutputSchema.parse(users);
  });

  it.each([
    [true, false, ["U12345678", "U23456789", "U34567890"]],
    [false, true, ["U12345678", "U23456789", "U45678901"]],
    [true, true, ["U12345678", "U23456789", "U34567890", "U45678901", "U56789012"]],
  ] as const)("filters includeDeleted=%s, includeBots=%s", async (includeDeleted, includeBots, expectedIds) => {
    const page = await invokeSlackListUsers(listUsersInputSchema.parse({ includeDeleted, includeBots, cursor: "users-next", limit: 5 }),
      context(), fakeSlack("users.list", { limit: "5", cursor: "users-next" }, userResponse));
    expect(page.users.map((user) => user.id)).toEqual(expectedIds);
    expect(page.nextCursor).toBe("users-next");
  });

  it("preserves the next cursor when all users are filtered out", async () => {
    expect(await invokeSlackListUsers(listUsersInputSchema.parse({}), context(), fakeSlack("users.list", { limit: "200" }, {
      ok: true, members: userResponse.members.slice(2), response_metadata: { next_cursor: "still-more" },
    }))).toEqual({ users: [], nextCursor: "still-more" });
  });
});

describe("error branching", () => {
  it.each(invocations.map((invoke, index) => [expectedSlugs[index], invoke] as const))("%s rejects Slack errors without retrying", async (_slug, invoke) => {
    let calls = 0;
    await expect(invoke(async () => {
      calls += 1;
      return Response.json({ ok: false, error: "channel_not_found" }, { status: 200 });
    })).rejects.toThrow(/channel_not_found/);
    expect(calls).toBe(1);
  });

  it.each(invocations.map((invoke, index) => [expectedSlugs[index], invoke] as const))("%s rejects missing connections before fetching", async (_slug, invoke) => {
    await expect(invoke(async () => { throw new Error("Unexpected fetch"); }, { ...context(), connections: {} })).rejects.toThrow(/missing_connection/);
  });

  it("uses the Slack ok field even for an HTTP error status", async () => {
    expect((await slackCall("auth.test", token, {}, {
      fetchImpl: async () => Response.json({ ok: true }, { status: 503 }),
    })).data.ok, "Slack's ok field, not HTTP success, determines the result").toBe(true);
  });

  it("rejects responses without a Slack ok field", async () => {
    await expect(slackCall("auth.test", token, {}, { fetchImpl: async () => Response.json({}) })).rejects.toThrow();
  });

  it("does not retry network errors", async () => {
    let networkCalls = 0;
    await expect(slackCall("chat.postMessage", token, {}, { fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("network unavailable");
    } })).rejects.toThrow(/network unavailable/);
    expect(networkCalls).toBe(1);
  });
});

describe("rate-limit budget and cancellation", () => {
  it("retries once within budget with the identical request body", async () => {
    let retryCalls = 0;
    let clock = 0;
    const waits: number[] = [];
    const retryBodies: string[] = [];
    await slackCall("chat.postMessage", token, { channel, text: "Hi", blocks }, {
      json: true, now: () => clock,
      sleepImpl: async (milliseconds, signal) => { expect(signal.aborted).toBe(false); waits.push(milliseconds); clock += milliseconds; },
      fetchImpl: async (_url, init) => {
        retryBodies.push(await new Response(init?.body).text());
        retryCalls += 1;
        return retryCalls === 1
          ? new Response("rate limit, not JSON", { status: 429, headers: { "Retry-After": "2" } })
          : Response.json({ ok: true });
      },
    });
    expect(retryCalls).toBe(2);
    expect(waits).toEqual([2000]);
    expect(retryBodies[0]).toBe(retryBodies[1]);
  });

  it.each([null, "", "invalid", "-1", "Infinity", "0.5", "16", "999999999999999999999"])("rejects Retry-After=%j without sleeping or retrying", async (retryAfter) => {
    let calls = 0;
    await expect(slackCall("users.list", token, {}, {
      fetchImpl: async () => { calls += 1; return new Response(null, { status: 429, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } }); },
      sleepImpl: async () => { expect.unreachable("Must not sleep outside budget"); },
    })).rejects.toThrow(/^slack:ratelimited/);
    expect(calls).toBe(1);
  });

  it("stops after a second rate limit", async () => {
    let repeatedCalls = 0;
    let repeatedWaits = 0;
    await expect(slackCall("users.list", token, {}, {
      fetchImpl: async () => { repeatedCalls += 1; return new Response(null, { status: 429, headers: { "Retry-After": "0" } }); },
      sleepImpl: async () => { repeatedWaits += 1; },
    })).rejects.toThrow(/^slack:ratelimited/);
    expect(repeatedCalls).toBe(2);
    expect(repeatedWaits).toBe(1);
  });

  it("counts elapsed request time against the retry budget", async () => {
    let clock = 0;
    await expect(slackCall("users.list", token, {}, {
      now: () => clock,
      fetchImpl: async () => { clock = 6000; return new Response(null, { status: 429, headers: { "Retry-After": "10" } }); },
      sleepImpl: async () => { expect.unreachable("Elapsed time must count against budget"); },
    })).rejects.toThrow(/^slack:ratelimited/);
  });

  it("cancels pending sleep and prevents fetching with an aborted signal", async () => {
    const abort = new AbortController();
    const pendingSleep = sleep(10_000, abort.signal);
    abort.abort(new Error("cancelled"));
    await expect(pendingSleep).rejects.toThrow(/cancelled/);
    await expect(slackCall("users.list", token, {}, {
      signal: abort.signal, fetchImpl: async () => { expect.unreachable("Aborted calls must not fetch"); },
    })).rejects.toThrow(/cancelled/);
  });

  it("resolves a zero-duration sleep", async () => {
    await sleep(0, new AbortController().signal);
  });
});

describe("schemas, manifest and route guards", () => {
  it("declares plugin identity, connection credentials and all five bricks", async () => {
    expect(manifest.slug).toBe("slack");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.triggers).toEqual([]);
    expect(manifest.connectionTypes.length).toBe(1);
    expect(manifest.connectionTypes[0]?.key).toBe("slack");
    expect(manifest.connectionTypes[0]?.validationBrick).toBe("slack-auth-test");
    expect(manifest.connectionTypes[0]?.credentialSchema.required).toEqual(["token"]);
    expect(manifest.bricks.map((brick) => brick.slug)).toEqual(expectedSlugs);
  });

  it.each(manifest.bricks)("$slug declares its endpoint, connection, retries and strict schemas", async (brick) => {
    expect(brick.endpointUrl).toBe(`${baseUrl}/bricks/${brick.slug}`);
    expect(brick.connections).toEqual({ slack: { typeKey: "slack", required: true } });
    expect(brick.callback).toBe(undefined);
    expect(brick.retries).toEqual(brick.slug === "slack-send-message" ? { limit: 0 } : undefined);
    expect(brick.inputSchema.additionalProperties).toBe(false);
    expect(brick.outputSchema.additionalProperties).toBe(false);
  });

  it.each(slackBricks(baseUrl))("$slug rejects unexpected input fields", async (brick) => {
    expect(brick.input.safeParse({ unexpected: true }).success).toBe(false);
  });

  it("rejects credentials in auth input", async () => {
    expect(authTestInputSchema.safeParse({ token }).success).toBe(false);
  });

  it.each([{ channel: "general", text: "Hi" }, { channel, text: "" }, { channel, text: "x".repeat(40001) },
    { channel, text: "Hi", threadTs: "bad" }, { channel, text: "Hi", blocks: Array(51).fill({}) }])("rejects invalid send-message input %#", async (bad) => {
    expect(sendMessageInputSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts message text and blocks at their size limits", async () => {
    expect(sendMessageInputSchema.safeParse({ channel, text: "x".repeat(40000), blocks: Array(50).fill({}) }).success).toBe(true);
  });

  it("rejects empty channel types and excessive page sizes", async () => {
    expect(listChannelsInputSchema.safeParse({ types: [] }).success).toBe(false);
    expect(listChannelsInputSchema.safeParse({ limit: 1001 }).success).toBe(false);
  });

  it("rejects a zero message page size", async () => {
    expect(readMessagesInputSchema.safeParse({ channel, limit: 0 }).success).toBe(false);
  });

  it("rejects excessive and fractional user page sizes", async () => {
    expect(listUsersInputSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(listUsersInputSchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });

  it("uses the supplied manifest base URL", async () => {
    expect(createSlackPluginManifest("https://other.example.test").bricks[0]?.endpointUrl).toBe("https://other.example.test/bricks/slack-auth-test");
  });

  it("requires a platform origin", async () => {
    expect(() => createSlackWorker(baseUrl, "")).toThrow();
  });

  it.each(manifest.bricks)("$slug rejects non-POST and unsigned requests", async (brick) => {
    const routedWorker = createSlackWorker(baseUrl, "https://platform.example.test");
    expect((await routedWorker.fetch(new Request(brick.endpointUrl))).status).toBe(405);
    expect((await routedWorker.fetch(new Request(brick.endpointUrl, { method: "POST" }))).status).toBe(401);
  });

  it("returns 404 for unknown routes", async () => {
    const routedWorker = createSlackWorker(baseUrl, "https://platform.example.test");
    expect((await routedWorker.fetch(new Request(`${baseUrl}/unknown`))).status).toBe(404);
  });
});

describe("SDK signed invocation and connection redemption", () => {
  // Exercise the real SDK: ES256 verification, discovery, redemption and Bearer translation.
  let signingKey: CryptoKey;
  let publicKey: object;
  beforeAll(async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    expect("publicKey" in keys && "privateKey" in keys).toBeTruthy();
    signingKey = keys.privateKey;
    publicKey = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "smoke-key", alg: "ES256" };
  });
  const origin = "https://platform.example.test";
  const issuer = "https://auth.example.test";
  async function signedToken(slug: string) {
    const now = Math.floor(Date.now() / 1000);
    const encoded = [
      { alg: "ES256", kid: "smoke-key" },
      { ...context().claims, brickId: `slack.${slug}`, iss: issuer, aud: "taskflow:brick", iat: now, exp: now + 60 },
    ].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, new TextEncoder().encode(encoded));
    return `${encoded}.${Buffer.from(signature).toString("base64url")}`;
  }

  let worker: typeof import("./index.js").default;
  let discoveries: number;
  let jwksRequests: number;
  let redemptions: number;
  let slackRequests: number;
  beforeEach(async () => {
    vi.resetModules();
    worker = (await import("./index.js")).default;
    discoveries = jwksRequests = redemptions = slackRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
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
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("manual");
        expect(JSON.parse(String(init?.body))).toEqual({ slotName: "slack" });
        expect(new Headers(init?.headers).get("authorization") ?? "").toMatch(/^Bearer ey/);
        return Response.json({ credentials: { token }, config: null });
      }
      slackRequests += 1;
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      const result = address.endsWith("/auth.test") ? authResponse
        : address.endsWith("/chat.postMessage") ? { ok: true, channel, ts }
        : address.endsWith("/conversations.list") ? { ok: true, channels: [] }
        : address.endsWith("/conversations.history") ? { ok: true, messages: [] }
        : address.endsWith("/users.list") ? { ok: true, members: [] }
        : expect.unreachable(`Unexpected URL: ${address}`);
      return Response.json(result);
    };
    vi.stubGlobal("fetch", fetchImpl);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // These requests share one worker lifecycle so the exact cache/redemption counts
  // also prove that repeated and rejected invocations do not perform extra work.
  it("verifies all bricks, reuses discovery/JWKS caches and rejects invalid requests", async () => {
    for (const slug of expectedSlugs) {
      const input = slug === "slack-send-message" ? { channel, text: "Hi" }
        : slug === "slack-read-messages" ? { channel } : {};
      const response = await worker.fetch(new Request(`${baseUrl}/bricks/${slug}`, {
        method: "POST", headers: { authorization: `Bearer ${await signedToken(slug)}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      }), { TASKFLOW_ORIGIN: origin });
      expect(response.status, await response.clone().text()).toBe(200);
      const authored = slackBricks(baseUrl).find((brick) => brick.slug === slug)!;
      authored.output.parse(await response.json());
    }
    expect(discoveries).toBe(5);
    expect(jwksRequests).toBe(5);
    expect(redemptions).toBe(5);
    expect(slackRequests).toBe(5);

    // A second invocation through the deployed entry point must reuse the SDK caches.
    const repeated = await worker.fetch(new Request(`${baseUrl}/bricks/slack-auth-test`, {
      method: "POST", headers: { authorization: `Bearer ${await signedToken("slack-auth-test")}`, "content-type": "application/json" },
      body: "{}",
    }), { TASKFLOW_ORIGIN: origin });
    expect(repeated.status, await repeated.clone().text()).toBe(200);
    expect(await repeated.json()).toEqual({ ...authExpected, scopes: [], missingScopes: [...MINIMUM_SCOPES] });
    expect(discoveries, "Repeated invocations must reuse discovery configuration").toBe(5);
    expect(jwksRequests, "Repeated invocations must reuse JWKS").toBe(5);
    expect(redemptions).toBe(6);
    expect(slackRequests).toBe(6);
    const wrongBrick = await worker.fetch(new Request(`${baseUrl}/bricks/slack-list-users`, {
      method: "POST", headers: { authorization: `Bearer ${await signedToken("slack-auth-test")}` }, body: "{}",
    }), { TASKFLOW_ORIGIN: origin });
    expect(wrongBrick.status).toBe(401);
    const invalidInput = await worker.fetch(new Request(`${baseUrl}/bricks/slack-auth-test`, {
      method: "POST", headers: { authorization: `Bearer ${await signedToken("slack-auth-test")}` }, body: JSON.stringify({ token }),
    }), { TASKFLOW_ORIGIN: origin });
    expect(invalidInput.status).toBe(400);
    expect(redemptions).toBe(6);
    expect(slackRequests).toBe(6);
  });
});
