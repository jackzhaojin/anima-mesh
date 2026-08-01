import type { DeliveryChannel, DeliveryMessage, ChannelContext, DeliveryResult } from "./types.js";
import { getEnv } from "../instance/env-core.js";

/**
 * Discord delivery, two modes:
 *  1. Webhook — DISCORD_WEBHOOK_URL set: post to the webhook (supports a
 *     username override for the persona).
 *  2. Bot DM — DISCORD_BOT_TOKEN + DISCORD_DM_USER_ID set: open (or reuse)
 *     the DM channel with the principal and send as the bot. This is the
 *     proven persona→principal reporting pattern.
 *
 * Content is capped by Discord at 2000 chars per message — long reports are
 * delivered as a sequence of messages, split at paragraph boundaries, so the
 * reader gets the whole brief. MAX_MESSAGES bounds a runaway report; only
 * past that does the tail truncate with a pointer back to the repo (the
 * artifact stays the source of truth).
 */
const CONTENT_LIMIT = 1900;
const MAX_MESSAGES = 8;
const TRUNCATION_NOTE = "\n…(truncated — full report lives in the brain repo)";
const API = "https://discord.com/api/v10";
// Discord rate-limits message sends per channel (typically 5 per 5s), so a
// long brief's chunk burst trips 429 partway — which used to fail the whole
// delivery mid-send: a partial DM and delivered:false (2026-08-01). A 429
// is a pacing instruction, not a failure: wait retry_after, resend the
// same request. Bounded so a hard limit still fails loud.
const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_MAX_WAIT_MS = 10_000;

async function fetchPaced(
  doFetch: typeof fetch,
  url: string,
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url, init);
    if (res.status !== 429 || attempt >= RATE_LIMIT_ATTEMPTS) return res;
    let waitMs = 1000;
    try {
      const body = (await res.json()) as { retry_after?: number };
      if (typeof body.retry_after === "number" && body.retry_after >= 0) {
        waitMs = Math.ceil(body.retry_after * 1000);
      }
    } catch {
      const header = Number(res.headers?.get?.("retry-after"));
      if (Number.isFinite(header) && header > 0) waitMs = header * 1000;
    }
    await new Promise((r) => setTimeout(r, Math.min(waitMs, RATE_LIMIT_MAX_WAIT_MS)));
  }
}

function mode(ctx: ChannelContext): "webhook" | "bot-dm" | null {
  if (getEnv(ctx.env, "DISCORD_WEBHOOK_URL")) return "webhook";
  if (getEnv(ctx.env, "DISCORD_BOT_TOKEN") && getEnv(ctx.env, "DISCORD_DM_USER_ID")) return "bot-dm";
  return null;
}

function buildChunks(msg: DeliveryMessage): string[] {
  const full = `**${msg.title}**\n\n${msg.body}`;
  const chunks: string[] = [];
  let rest = full;
  while (rest.length > CONTENT_LIMIT) {
    const window = rest.slice(0, CONTENT_LIMIT);
    // Prefer a paragraph break, then a line break; a break in the first half
    // wastes too much of the message, so fall through to a hard cut instead.
    let cut = window.lastIndexOf("\n\n");
    if (cut < CONTENT_LIMIT / 2) cut = window.lastIndexOf("\n");
    if (cut < CONTENT_LIMIT / 2) cut = CONTENT_LIMIT;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) chunks.push(rest);
  if (chunks.length > MAX_MESSAGES) {
    const kept = chunks.slice(0, MAX_MESSAGES);
    const last = kept[MAX_MESSAGES - 1]!;
    kept[MAX_MESSAGES - 1] = last.slice(0, CONTENT_LIMIT - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
    return kept;
  }
  return chunks;
}

export const discordChannel: DeliveryChannel = {
  name: "discord",

  assertConfigured(ctx: ChannelContext): void {
    if (!mode(ctx)) {
      throw new Error(
        "discord channel: set DISCORD_WEBHOOK_URL, or DISCORD_BOT_TOKEN + DISCORD_DM_USER_ID for bot-DM mode",
      );
    }
  },

  async deliver(msg: DeliveryMessage, ctx: ChannelContext): Promise<DeliveryResult> {
    const doFetch = ctx.fetchImpl ?? fetch;
    const chunks = buildChunks(msg);
    const totalChars = chunks.reduce((n, c) => n + c.length, 0);
    const via = mode(ctx);

    if (via === "webhook") {
      // Sequential sends keep the chunks in reading order.
      for (const content of chunks) {
        const res = await fetchPaced(doFetch, getEnv(ctx.env, "DISCORD_WEBHOOK_URL")!, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, ...(msg.sender ? { username: msg.sender } : {}) }),
        });
        if (!res.ok) {
          throw new Error(`discord webhook → HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
        }
      }
      return { channel: "discord", ok: true, detail: `webhook: posted ${totalChars} chars in ${chunks.length} message(s)` };
    }

    // bot-DM mode
    const auth = { Authorization: `Bot ${getEnv(ctx.env, "DISCORD_BOT_TOKEN")!}`, "Content-Type": "application/json" };
    const dmRes = await fetchPaced(doFetch, `${API}/users/@me/channels`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ recipient_id: getEnv(ctx.env, "DISCORD_DM_USER_ID")! }),
    });
    if (!dmRes.ok) {
      throw new Error(`discord DM open → HTTP ${dmRes.status} ${await dmRes.text().catch(() => "")}`.trim());
    }
    const { id: channelId } = (await dmRes.json()) as { id: string };

    for (const content of chunks) {
      const sendRes = await fetchPaced(doFetch, `${API}/channels/${channelId}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ content }),
      });
      if (!sendRes.ok) {
        throw new Error(`discord DM send → HTTP ${sendRes.status} ${await sendRes.text().catch(() => "")}`.trim());
      }
    }
    return { channel: "discord", ok: true, detail: `bot DM: sent ${totalChars} chars in ${chunks.length} message(s)` };
  },
};
