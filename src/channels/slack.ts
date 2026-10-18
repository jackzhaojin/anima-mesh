import type { DeliveryChannel, DeliveryMessage, ChannelContext, DeliveryResult } from "./types.js";
import { getEnv } from "../instance/env-core.js";

/**
 * Slack delivery, two modes:
 *  1. Bot - SLACK_BOT_TOKEN + SLACK_CHANNEL_ID set: chat.postMessage into a
 *     channel (C…/G… id; the bot must be invited) or a user id (U…, lands
 *     in the app's DM). A long brief posts its head to the channel and the
 *     rest as replies in that message's thread, so a shared channel shows
 *     one brief per day, not a wall.
 *  2. Webhook - SLACK_WEBHOOK_URL set: an incoming webhook bound to one
 *     channel at install time. Webhooks cannot thread; chunks post in order.
 * Bot mode wins when both are configured (it threads).
 *
 * Content travels as Slack's `markdown` block, which renders the report's
 * standard Markdown (headings, bold, links, lists, tables) as written - no
 * mrkdwn conversion layer to drift. All markdown blocks in one payload share
 * a 12,000-char limit, so each message carries one block under that.
 *
 * The Web API answers HTTP 200 with `{ ok: false, error }` for most
 * failures - every call checks `ok`, not just the status.
 */
const CONTENT_LIMIT = 11_000;
const MAX_MESSAGES = 6;
const TRUNCATION_NOTE = "\n\n…(truncated - full report lives in the brain repo)";
const API = "https://slack.com/api";
// chat.postMessage is rate-limited per channel (about one per second, with
// bursts tolerated). A 429 carries Retry-After in seconds - a pacing
// instruction, not a failure. Bounded so a hard limit still fails loud.
const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_MAX_WAIT_MS = 10_000;
/** The fallback `text` (notifications, screen readers) is plain and short. */
const FALLBACK_TEXT_LIMIT = 300;

async function fetchPaced(
  doFetch: typeof fetch,
  url: string,
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url, init);
    if (res.status !== 429 || attempt >= RATE_LIMIT_ATTEMPTS) return res;
    const header = Number(res.headers?.get?.("retry-after"));
    const waitMs = Number.isFinite(header) && header > 0 ? header * 1000 : 1000;
    await new Promise((r) => setTimeout(r, Math.min(waitMs, RATE_LIMIT_MAX_WAIT_MS)));
  }
}

function mode(ctx: ChannelContext): "bot" | "webhook" | null {
  if (getEnv(ctx.env, "SLACK_BOT_TOKEN") && getEnv(ctx.env, "SLACK_CHANNEL_ID")) return "bot";
  if (getEnv(ctx.env, "SLACK_WEBHOOK_URL")) return "webhook";
  return null;
}

/** Split Markdown into Slack-sized chunks at paragraph, then line, boundaries. */
export function slackChunks(markdown: string, limit = CONTENT_LIMIT, maxMessages = MAX_MESSAGES): string[] {
  const chunks: string[] = [];
  let rest = markdown;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit / 2) cut = window.lastIndexOf("\n");
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) chunks.push(rest);
  if (chunks.length > maxMessages) {
    const kept = chunks.slice(0, maxMessages);
    const last = kept[maxMessages - 1]!;
    kept[maxMessages - 1] = last.slice(0, limit - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
    return kept;
  }
  return chunks;
}

/** Markdown → a short plain fallback for `text` (notification preview). */
function fallbackText(markdown: string): string {
  const plain = markdown
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > FALLBACK_TEXT_LIMIT ? `${plain.slice(0, FALLBACK_TEXT_LIMIT - 1)}…` : plain;
}

function messagePayload(markdown: string): { text: string; blocks: unknown[] } {
  return { text: fallbackText(markdown), blocks: [{ type: "markdown", text: markdown }] };
}

export interface SlackApiContext {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * One Web API call with the bot token. Throws on HTTP failure or
 * `ok: false`, naming the method and Slack's error code (e.g.
 * `not_in_channel`, `missing_scope`) - the setup hint operators need.
 */
export async function slackApi<T = Record<string, unknown>>(
  ctx: SlackApiContext,
  method: string,
  args: Record<string, unknown>,
  httpMethod: "GET" | "POST" = "POST",
): Promise<T & { ok: true }> {
  const token = getEnv(ctx.env, "SLACK_BOT_TOKEN");
  if (!token) throw new Error(`slack ${method}: SLACK_BOT_TOKEN is not set`);
  const doFetch = ctx.fetchImpl ?? fetch;
  let res: Response;
  if (httpMethod === "GET") {
    const qs = new URLSearchParams(
      Object.entries(args)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]): [string, string] => [k, String(v)]),
    );
    res = await fetchPaced(doFetch, `${API}/${method}?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  } else {
    res = await fetchPaced(doFetch, `${API}/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(args),
    });
  }
  if (!res.ok) throw new Error(`slack ${method} → HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  const body = (await res.json()) as { ok?: boolean; error?: string } & T;
  if (!body.ok) throw new Error(`slack ${method} → ${body.error ?? "not ok"}`);
  return body as T & { ok: true };
}

/**
 * Post Markdown as the bot. The first chunk opens (or joins) the thread;
 * later chunks always reply in it. Returns the first message's ts.
 */
export async function postSlackMarkdown(
  ctx: SlackApiContext,
  target: { channel: string; threadTs?: string },
  markdown: string,
): Promise<{ ts: string; messages: number }> {
  const chunks = slackChunks(markdown);
  let threadTs = target.threadTs;
  let firstTs = "";
  for (const chunk of chunks) {
    const res = await slackApi<{ ts: string }>(ctx, "chat.postMessage", {
      channel: target.channel,
      ...messagePayload(chunk),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      unfurl_links: false,
    });
    if (!firstTs) firstTs = res.ts;
    threadTs ??= res.ts;
  }
  return { ts: firstTs, messages: chunks.length };
}

export const slackChannel: DeliveryChannel = {
  name: "slack",

  assertConfigured(ctx: ChannelContext): void {
    if (!mode(ctx)) {
      throw new Error("slack channel: set SLACK_BOT_TOKEN + SLACK_CHANNEL_ID (bot mode), or SLACK_WEBHOOK_URL");
    }
  },

  async deliver(msg: DeliveryMessage, ctx: ChannelContext): Promise<DeliveryResult> {
    // The report body already opens with its own "# Title" heading; only
    // prepend the title when the body does not.
    const markdown = msg.body.trimStart().startsWith("# ") ? msg.body : `# ${msg.title}\n\n${msg.body}`;
    const via = mode(ctx);

    if (via === "bot") {
      const { messages } = await postSlackMarkdown(ctx, { channel: getEnv(ctx.env, "SLACK_CHANNEL_ID")! }, markdown);
      return {
        channel: "slack",
        ok: true,
        detail: `bot: posted ${markdown.length} chars in ${messages} message(s)${messages > 1 ? " (threaded)" : ""}`,
      };
    }

    const doFetch = ctx.fetchImpl ?? fetch;
    const chunks = slackChunks(markdown);
    for (const chunk of chunks) {
      const res = await fetchPaced(doFetch, getEnv(ctx.env, "SLACK_WEBHOOK_URL")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...messagePayload(chunk), unfurl_links: false }),
      });
      if (!res.ok) {
        throw new Error(`slack webhook → HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
      }
    }
    return { channel: "slack", ok: true, detail: `webhook: posted ${markdown.length} chars in ${chunks.length} message(s)` };
  },
};

// ---- inbound helpers (the Worker's Events API edge + DirectionDO) -----------

/** Slack's three HTML entities, decoded; everything else is literal. */
function decodeEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * An inbound message's text with the bot's own mention removed and Slack's
 * link markup flattened: `<url|label>` → `label (url)`, `<url>` → `url`.
 * Other people's `<@U…>` mentions stay - they mean something in a group.
 */
export function cleanSlackText(text: string, botUserId?: string): string {
  let out = text;
  if (botUserId) out = out.split(`<@${botUserId}>`).join(" ");
  out = out.replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "$2 ($1)").replace(/<((?:https?|mailto):[^>]+)>/g, "$1");
  return decodeEntities(out).replace(/[ \t]+/g, " ").trim();
}

interface SlackHistoryMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
}

const CONTEXT_MESSAGES = 12;
const CONTEXT_LINE_LIMIT = 600;
const CONTEXT_TOTAL_LIMIT = 5000;

/**
 * The conversation around an inbound mention, oldest first - the thread
 * when it was a threaded reply, else the channel's recent messages. This
 * is how the persona follows a group conversation instead of answering one
 * line in a vacuum. Needs the history scopes (channels/groups/im:history);
 * callers treat a throw as "no context", never as a failed direction.
 */
export async function slackConversationContext(
  ctx: SlackApiContext,
  at: { channel: string; ts: string; threadTs?: string; botUserId?: string },
): Promise<string> {
  const res = at.threadTs
    ? await slackApi<{ messages?: SlackHistoryMessage[] }>(
        ctx,
        "conversations.replies",
        { channel: at.channel, ts: at.threadTs, limit: CONTEXT_MESSAGES + 1 },
        "GET",
      )
    : await slackApi<{ messages?: SlackHistoryMessage[] }>(
        ctx,
        "conversations.history",
        { channel: at.channel, latest: at.ts, inclusive: false, limit: CONTEXT_MESSAGES },
        "GET",
      );
  let messages = (res.messages ?? []).filter((m) => m.ts !== at.ts && m.text && m.subtype !== "channel_join");
  // replies come oldest-first; history newest-first.
  if (!at.threadTs) messages = messages.reverse();
  messages = messages.slice(-CONTEXT_MESSAGES);

  const lines: string[] = [];
  let total = 0;
  for (const m of messages.reverse()) {
    const who = m.user && m.user === at.botUserId ? "you" : m.user ? `<@${m.user}>` : m.bot_id ? `bot:${m.bot_id}` : "unknown";
    let text = cleanSlackText(m.text ?? "").replace(/\n+/g, " ");
    if (text.length > CONTEXT_LINE_LIMIT) text = `${text.slice(0, CONTEXT_LINE_LIMIT - 1)}…`;
    const line = `${who}: ${text}`;
    if (total + line.length > CONTEXT_TOTAL_LIMIT) break;
    total += line.length;
    lines.unshift(line); // walked newest-first so the budget keeps the most recent
  }
  return lines.join("\n");
}

// ---- polled mentions (the laptop tier's ear; no public endpoint) -----------

export interface SlackMention {
  channel: string;
  /** The mention's own ts - the dedup key (ledger `messageId`). */
  ts: string;
  /** Where the reply goes: the parent's ts (a top-level mention starts its own thread). */
  threadTs: string;
  /** True when the mention was itself a reply inside an existing thread. */
  inThread: boolean;
  user: string;
  /** Cleaned text - the bot's own mention removed. */
  text: string;
}

interface SlackPolledMessage extends SlackHistoryMessage {
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

const POLL_HISTORY_LIMIT = 100;
const POLL_REPLIES_LIMIT = 100;

/**
 * Mentions of the bot in `channels` since `oldest` (a Slack ts), oldest
 * first - top-level messages plus replies in threads that moved since
 * `oldest`. Bot-authored messages and edits never count (no agent loops).
 * Sender gating is the caller's: it gets every human mention with its
 * user id and decides. Pure fetch - usable from either tier.
 */
export async function findSlackMentions(
  ctx: SlackApiContext,
  opts: { channels: string[]; botUserId: string; oldest: string },
): Promise<SlackMention[]> {
  const tag = `<@${opts.botUserId}>`;
  const found: SlackMention[] = [];
  const consider = (channel: string, m: SlackPolledMessage, parentTs: string | undefined): void => {
    if (!m.ts || !m.user || m.bot_id || m.subtype || m.user === opts.botUserId) return;
    if (!(m.text ?? "").includes(tag)) return;
    if (Number(m.ts) <= Number(opts.oldest)) return;
    found.push({
      channel,
      ts: m.ts,
      threadTs: parentTs ?? m.ts,
      inThread: parentTs !== undefined,
      user: m.user,
      text: cleanSlackText(m.text ?? "", opts.botUserId),
    });
  };

  for (const channel of opts.channels) {
    // One recent window, filtered by ts: a thread's parent can be older than
    // `oldest` while its replies are new, so the window is not cut at oldest.
    const history = await slackApi<{ messages?: SlackPolledMessage[] }>(
      ctx,
      "conversations.history",
      { channel, limit: POLL_HISTORY_LIMIT },
      "GET",
    );
    const parents: string[] = [];
    for (const m of history.messages ?? []) {
      consider(channel, m, undefined);
      if ((m.reply_count ?? 0) > 0 && m.ts && Number(m.latest_reply ?? 0) > Number(opts.oldest)) parents.push(m.ts);
    }
    for (const parentTs of parents) {
      const replies = await slackApi<{ messages?: SlackPolledMessage[] }>(
        ctx,
        "conversations.replies",
        { channel, ts: parentTs, oldest: opts.oldest, limit: POLL_REPLIES_LIMIT },
        "GET",
      );
      for (const r of replies.messages ?? []) {
        if (r.ts === parentTs) continue; // the parent itself was considered above
        consider(channel, r, parentTs);
      }
    }
  }
  const seen = new Set<string>();
  return found
    .filter((m) => (seen.has(`${m.channel}:${m.ts}`) ? false : (seen.add(`${m.channel}:${m.ts}`), true)))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}
