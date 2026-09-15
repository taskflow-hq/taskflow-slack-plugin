import { createBrickHandler, type BrickHandlerContext } from "@flowbrew/plugin-sdk";
import * as z from "zod/v4";

import {
  authTestInputSchema, authTestOutputSchema, invokeSlackAuthTest,
  sendMessageInputSchema, sendMessageOutputSchema, invokeSlackSendMessage,
  listChannelsInputSchema, listChannelsOutputSchema, invokeSlackListChannels,
  readMessagesInputSchema, readMessagesOutputSchema, invokeSlackReadMessages,
  listUsersInputSchema, listUsersOutputSchema, invokeSlackListUsers,
} from "./bricks.js";
import { createSlackPlugin } from "./manifest.js";

export function createSlackWorker(baseUrl: string, origin: string, fetchImpl: typeof fetch = fetch) {
  const plugin = createSlackPlugin(baseUrl);
  const platformOrigin = z.url().parse(origin);
  function brick<I, O>(
    slug: string, input: z.ZodType<I>, output: z.ZodType<O>,
    invoke: (input: I, context: BrickHandlerContext, fetchImpl: typeof fetch) => Promise<O>,
  ) {
    return createBrickHandler({
      plugin, brickId: `slack.${slug}`, input, output, origin: platformOrigin,
      handler: (parsedInput, context) => invoke(parsedInput, context, fetchImpl),
    });
  }
  const handlers = new Map([
    ["/bricks/slack-auth-test", brick("slack-auth-test", authTestInputSchema, authTestOutputSchema, invokeSlackAuthTest)],
    ["/bricks/slack-send-message", brick("slack-send-message", sendMessageInputSchema, sendMessageOutputSchema, invokeSlackSendMessage)],
    ["/bricks/slack-list-channels", brick("slack-list-channels", listChannelsInputSchema, listChannelsOutputSchema, invokeSlackListChannels)],
    ["/bricks/slack-read-messages", brick("slack-read-messages", readMessagesInputSchema, readMessagesOutputSchema, invokeSlackReadMessages)],
    ["/bricks/slack-list-users", brick("slack-list-users", listUsersInputSchema, listUsersOutputSchema, invokeSlackListUsers)],
  ]);
  return {
    fetch(request: Request) {
      const handler = handlers.get(new URL(request.url).pathname);
      return handler ? handler.fetch(request) : new Response("Not found", { status: 404 });
    },
  };
}

export type Env = { TASKFLOW_ORIGIN: string };

export default {
  fetch(request: Request, env: Env) {
    return createSlackWorker(new URL(request.url).origin, env.TASKFLOW_ORIGIN).fetch(request);
  },
};
