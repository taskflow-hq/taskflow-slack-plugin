import * as z from "zod/v4";

const CALL_BUDGET_MS = 20_000;
const RETRY_HEADROOM_MS = 5_000;
const envelopeSchema = z.object({ ok: z.boolean(), error: z.string().optional() }).loose();

type SlackCallOptions = {
  json?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function slackCall(
  method: string,
  token: string,
  params: Record<string, unknown>,
  options: SlackCallOptions = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("slack:timeout")), CALL_BUDGET_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const entries = Object.entries(params).filter(([, value]) => value !== undefined);
  const body = options.json
    ? JSON.stringify(Object.fromEntries(entries))
    : new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal.throwIfAborted();
      const response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": options.json
            ? "application/json; charset=utf-8"
            : "application/x-www-form-urlencoded; charset=utf-8",
        },
        body,
        redirect: "manual",
        signal,
      });
      // HTTP status matters only for Slack's transport-level rate limit.
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter !== null && /^\d+$/.test(retryAfter.trim())
          ? Number(retryAfter) * 1000
          : NaN;
        await response.body?.cancel();
        if (attempt !== 0 || !Number.isFinite(delay)
          || now() - startedAt + delay > CALL_BUDGET_MS - RETRY_HEADROOM_MS) {
          throw new Error(`slack:ratelimited (${method}); retry does not fit the call budget`);
        }
        await (options.sleepImpl ?? sleep)(delay, signal);
        if (now() - startedAt > CALL_BUDGET_MS - RETRY_HEADROOM_MS) {
          throw new Error(`slack:ratelimited (${method}); retry budget exhausted`);
        }
        continue;
      }
      const data = envelopeSchema.parse(await response.json());
      if (!data.ok) throw new Error(`slack:${data.error ?? "unknown_error"} (${method})`);
      return { data, headers: response.headers };
    }
    throw new Error(`slack:ratelimited (${method})`);
  } finally {
    clearTimeout(timer);
  }
}
