import type { AuthoredBrick, BrickHandlerContext, PluginManifest } from "@flowbrew/plugin-sdk";
import * as z from "zod/v4";

import { slackCall } from "./slack-api.js";

export const MINIMUM_SCOPES = ["chat:write", "channels:read", "channels:history", "users:read"];

export const authTestInputSchema = z.object({}).strict();
export const authTestOutputSchema = z.object({
  teamId: z.string(), team: z.string(), botUserId: z.string(), userId: z.string(),
  url: z.string(), scopes: z.array(z.string()), missingScopes: z.array(z.string()),
}).strict();

export const sendMessageInputSchema = z.object({
  channel: z.string().regex(/^[CDG][A-Z0-9]{8,}$/),
  text: z.string().min(1).max(40000),
  threadTs: z.string().regex(/^\d{10}\.\d{6}$/).optional(),
  replyBroadcast: z.boolean().optional(),
  blocks: z.array(z.record(z.string(), z.json())).max(50).optional(),
  unfurlLinks: z.boolean().default(false),
  unfurlMedia: z.boolean().default(false),
}).strict();
export const sendMessageOutputSchema = z.object({ channel: z.string(), ts: z.string() }).strict();

export const listChannelsInputSchema = z.object({
  types: z.array(z.enum(["public_channel", "private_channel", "mpim", "im"])).min(1).default(["public_channel"]),
  excludeArchived: z.boolean().default(true),
  limit: z.number().int().min(1).max(1000).default(200),
  cursor: z.string().optional(),
}).strict();
export const listChannelsOutputSchema = z.object({
  channels: z.array(z.object({
    id: z.string(), name: z.string(), isPrivate: z.boolean(), isArchived: z.boolean(),
    isMember: z.boolean(), isIm: z.boolean(), topic: z.string(), purpose: z.string(),
    numMembers: z.number().nullable(),
  }).strict()),
  nextCursor: z.string().nullable(),
}).strict();

export const readMessagesInputSchema = z.object({
  channel: z.string().regex(/^[CDG][A-Z0-9]{8,}$/),
  threadTs: z.string().regex(/^\d{10}\.\d{6}$/).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  cursor: z.string().optional(),
  oldest: z.string().optional(),
  latest: z.string().optional(),
  inclusive: z.boolean().optional(),
}).strict();
export const readMessagesOutputSchema = z.object({
  messages: z.array(z.object({
    ts: z.string(), threadTs: z.string().nullable(), userId: z.string().nullable(),
    botId: z.string().nullable(), subtype: z.string().nullable(), text: z.string(),
    replyCount: z.number().nullable(), edited: z.boolean(),
    reactions: z.array(z.object({ name: z.string(), count: z.number() }).strict()),
    files: z.array(z.object({
      id: z.string(), name: z.string().nullable(), mimetype: z.string().nullable(), size: z.number().nullable(),
    }).strict()),
  }).strict()),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
}).strict();

export const listUsersInputSchema = z.object({
  limit: z.number().int().min(1).max(200).default(200),
  cursor: z.string().optional(),
  includeDeleted: z.boolean().default(false),
  includeBots: z.boolean().default(false),
}).strict();
export const listUsersOutputSchema = z.object({
  users: z.array(z.object({
    id: z.string(), name: z.string(), realName: z.string().nullable(),
    displayName: z.string().nullable(), email: z.string().nullable(), isBot: z.boolean(),
    isAdmin: z.boolean().nullable(), deleted: z.boolean(), tz: z.string().nullable(),
  }).strict()),
  nextCursor: z.string().nullable(),
}).strict();

const pagination = {
  response_metadata: z.object({ next_cursor: z.string().nullish() }).nullish(),
};
function nextCursor(data: z.infer<z.ZodObject<typeof pagination>>): string | null {
  return data.response_metadata?.next_cursor?.trim() || null;
}
function slackToken(context: BrickHandlerContext): string {
  const token = context.connections.slack?.token;
  if (!token) throw new Error("slack:missing_connection; a Slack bot token is required");
  return token;
}

export async function invokeSlackAuthTest(
  _input: z.infer<typeof authTestInputSchema>,
  context: BrickHandlerContext,
  fetchImpl: typeof fetch = fetch,
) {
  const { data, headers } = await slackCall("auth.test", slackToken(context), {}, {
    signal: context.signal, fetchImpl,
  });
  if (typeof data.bot_id !== "string" || data.bot_id.length === 0) {
    throw new Error("slack:bot_token_required; auth.test returned no bot_id. Connect a bot token (xoxb-), not a user token (xoxp-).");
  }
  const auth = z.object({
    team_id: z.string(), team: z.string(), user_id: z.string(), url: z.string(),
  }).parse(data);
  const scopes = (headers.get("X-OAuth-Scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);
  return {
    teamId: auth.team_id, team: auth.team, botUserId: data.bot_id, userId: auth.user_id,
    url: auth.url, scopes, missingScopes: MINIMUM_SCOPES.filter((scope) => !scopes.includes(scope)),
  };
}

export async function invokeSlackSendMessage(
  input: z.infer<typeof sendMessageInputSchema>,
  context: BrickHandlerContext,
  fetchImpl: typeof fetch = fetch,
) {
  const { data } = await slackCall("chat.postMessage", slackToken(context), {
    channel: input.channel, text: input.text, thread_ts: input.threadTs,
    reply_broadcast: input.replyBroadcast, blocks: input.blocks,
    unfurl_links: input.unfurlLinks, unfurl_media: input.unfurlMedia,
  }, { json: true, signal: context.signal, fetchImpl });
  const message = z.object({ channel: z.string(), ts: z.string() }).parse(data);
  return { channel: message.channel, ts: message.ts };
}

export async function invokeSlackListChannels(
  input: z.infer<typeof listChannelsInputSchema>,
  context: BrickHandlerContext,
  fetchImpl: typeof fetch = fetch,
) {
  const { data } = await slackCall("conversations.list", slackToken(context), {
    types: input.types.join(","), exclude_archived: input.excludeArchived,
    limit: input.limit, cursor: input.cursor,
  }, { signal: context.signal, fetchImpl });
  const page = z.object({
    channels: z.array(z.object({
      id: z.string(), name: z.string().nullish(), is_private: z.boolean().optional(),
      is_archived: z.boolean().optional(), is_member: z.boolean().optional(), is_im: z.boolean().optional(),
      topic: z.object({ value: z.string().nullish() }).nullish(),
      purpose: z.object({ value: z.string().nullish() }).nullish(),
      num_members: z.number().nullish(),
    })),
    ...pagination,
  }).parse(data);
  return {
    channels: page.channels.map((channel) => ({
      id: channel.id, name: channel.name ?? "", isPrivate: channel.is_private ?? false,
      isArchived: channel.is_archived ?? false, isMember: channel.is_member ?? false,
      isIm: channel.is_im ?? false, topic: channel.topic?.value ?? "", purpose: channel.purpose?.value ?? "",
      numMembers: channel.num_members ?? null,
    })),
    nextCursor: nextCursor(page),
  };
}

export async function invokeSlackReadMessages(
  input: z.infer<typeof readMessagesInputSchema>,
  context: BrickHandlerContext,
  fetchImpl: typeof fetch = fetch,
) {
  const { data } = await slackCall(
    input.threadTs === undefined ? "conversations.history" : "conversations.replies",
    slackToken(context), {
      channel: input.channel, ts: input.threadTs, limit: input.limit, cursor: input.cursor,
      oldest: input.oldest, latest: input.latest, inclusive: input.inclusive,
    }, { signal: context.signal, fetchImpl },
  );
  const page = z.object({
    messages: z.array(z.object({
      ts: z.string(), thread_ts: z.string().nullish(), user: z.string().nullish(),
      bot_id: z.string().nullish(), subtype: z.string().nullish(), text: z.string().nullish(),
      reply_count: z.number().nullish(), edited: z.object({}).nullish(),
      reactions: z.array(z.object({ name: z.string(), count: z.number() })).optional(),
      files: z.array(z.object({
        id: z.string(), name: z.string().nullish(), mimetype: z.string().nullish(), size: z.number().nullish(),
      })).optional(),
    })),
    has_more: z.boolean().optional(),
    ...pagination,
  }).parse(data);
  return {
    messages: page.messages.map((message) => ({
      ts: message.ts, threadTs: message.thread_ts ?? null, userId: message.user ?? null,
      botId: message.bot_id ?? null, subtype: message.subtype ?? null, text: message.text ?? "",
      replyCount: message.reply_count ?? null, edited: message.edited != null,
      reactions: (message.reactions ?? []).map(({ name, count }) => ({ name, count })),
      files: (message.files ?? []).map((file) => ({
        id: file.id, name: file.name ?? null, mimetype: file.mimetype ?? null, size: file.size ?? null,
      })),
    })),
    hasMore: page.has_more ?? false,
    nextCursor: nextCursor(page),
  };
}

export async function invokeSlackListUsers(
  input: z.infer<typeof listUsersInputSchema>,
  context: BrickHandlerContext,
  fetchImpl: typeof fetch = fetch,
) {
  const { data } = await slackCall("users.list", slackToken(context), {
    limit: input.limit, cursor: input.cursor,
  }, { signal: context.signal, fetchImpl });
  const page = z.object({
    members: z.array(z.object({
      id: z.string(), name: z.string(), real_name: z.string().nullish(),
      profile: z.object({ display_name: z.string().nullish(), email: z.string().nullish() }).nullish(),
      is_bot: z.boolean().optional(), is_admin: z.boolean().nullish(),
      deleted: z.boolean().optional(), tz: z.string().nullish(),
    })),
    ...pagination,
  }).parse(data);
  return {
    users: page.members.filter((user) => user.id !== "USLACKBOT"
      && (input.includeDeleted || !user.deleted) && (input.includeBots || !user.is_bot))
      .map((user) => ({
        id: user.id, name: user.name, realName: user.real_name ?? null,
        displayName: user.profile?.display_name ?? null, email: user.profile?.email ?? null,
        isBot: user.is_bot ?? false, isAdmin: user.is_admin ?? null,
        deleted: user.deleted ?? false, tz: user.tz ?? null,
      })),
    nextCursor: nextCursor(page),
  };
}

function endpoint(baseUrl: string, slug: string): string {
  return new URL(`/bricks/${slug}`, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

// SDK 0.2.1 adds connections on AuthoredPluginManifest's brick element, not AuthoredBrick itself.
type ConnectedBrick = AuthoredBrick & { connections: PluginManifest["bricks"][number]["connections"] };
const connections = { slack: { typeKey: "slack", required: true } } as const;

export function slackBricks(baseUrl: string): ConnectedBrick[] {
  return [
    {
      slug: "slack-auth-test", name: "Validate Slack bot token",
      description: "Validate the connected Slack bot token (auth.test). Rejects invalid tokens and user tokens without bot_id. Returns workspace and bot identity, granted scopes from X-OAuth-Scopes, and advisory missingScopes for chat:write, channels:read, channels:history and users:read; missing scopes do not fail validation.",
      endpointUrl: endpoint(baseUrl, "slack-auth-test"),
      input: authTestInputSchema, output: authTestOutputSchema, connections,
    },
    {
      slug: "slack-send-message", name: "Send Slack message",
      description: "Post a message to a Slack channel, DM or thread using the connected bot token (chat.postMessage). channel must be a Slack ID (C…/G…/D…), not a name; use slack.slack-list-channels to resolve names. text is Slack mrkdwn (use <@U123> for mentions, <#C123> for channels, not Markdown). Pass threadTs to reply in a thread. blocks is optional raw Block Kit; text is then the notification fallback. Returns { channel, ts }; use ts as threadTs for follow-ups. Fails with channel_not_found or not_in_channel when the bot is not a member (invite the bot, or grant chat:write.public for public channels). Not idempotent: never retry blindly, a retry posts a duplicate. For a Slack-native approval flow, post a Block Kit actions block containing a url-type button pointing at the url returned by core.create-approval-gate — no dedicated Slack approval brick exists; this composition is the whole mechanism.",
      endpointUrl: endpoint(baseUrl, "slack-send-message"),
      input: sendMessageInputSchema, output: sendMessageOutputSchema, connections, retries: { limit: 0 },
    },
    {
      slug: "slack-list-channels", name: "List Slack channels",
      description: "List Slack conversations visible to the connected bot (conversations.list), one page per call. Default returns non-archived public channels; set types to include private_channel, mpim or im (needs groups:read / mpim:read / im:read scopes on the connection). Returns { channels, nextCursor }. Slack may return fewer than limit even when more pages exist: loop while nextCursor is not null, passing it back as cursor. isMember tells whether the bot can read/post there.",
      endpointUrl: endpoint(baseUrl, "slack-list-channels"),
      input: listChannelsInputSchema, output: listChannelsOutputSchema, connections,
    },
    {
      slug: "slack-read-messages", name: "Read Slack messages",
      description: "Read one page of messages from a Slack channel (conversations.history) or, when threadTs is given, one page of a thread's replies (conversations.replies, parent message first). channel must be an ID; the bot must be a member. Returns { messages, hasMore, nextCursor }; loop while nextCursor is not null. Messages are newest-first; use oldest/latest (Slack ts strings) to bound the range. text is raw Slack mrkdwn with <@U…> mentions unresolved. files contains metadata only, no download URLs — there is no file-download brick in this plugin yet.",
      endpointUrl: endpoint(baseUrl, "slack-read-messages"),
      input: readMessagesInputSchema, output: readMessagesOutputSchema, connections,
    },
    {
      slug: "slack-list-users", name: "List Slack users",
      description: "List members of the connected Slack workspace (users.list), one page per call. Returns { users, nextCursor }; loop while nextCursor is not null and never treat a short page as the end (deleted accounts and bots are filtered out client-side unless includeDeleted / includeBots are true, so a page can be shorter than limit while more remain). email is null unless the token has users:read.email. Use id (U…) for mentions in slack.slack-send-message.",
      endpointUrl: endpoint(baseUrl, "slack-list-users"),
      input: listUsersInputSchema, output: listUsersOutputSchema, connections,
    },
  ];
}
