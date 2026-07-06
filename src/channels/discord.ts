import type { DeliveryChannel, DeliveryMessage, ChannelContext, DeliveryResult } from "./types.js";
import { getEnv } from "../instance/env.js";

/**
 * Discord delivery, two modes:
 *  1. Webhook — DISCORD_WEBHOOK_URL set: post to the webhook (supports a
 *     username override for the persona).
 *  2. Bot DM — DISCORD_BOT_TOKEN + DISCORD_DM_USER_ID set: open (or reuse)
 *     the DM channel with the principal and send as the bot. This is the
 *     proven persona→principal reporting pattern.
 *
 * Content is capped by Discord at 2000 chars — long reports are truncated
 * with a pointer back to the repo (the artifact stays the source of truth).
 */
const CONTENT_LIMIT = 1900;
const API = "https://discord.com/api/v10";

function mode(ctx: ChannelContext): "webhook" | "bot-dm" | null {
  if (getEnv(ctx.env, "DISCORD_WEBHOOK_URL")) return "webhook";
  if (getEnv(ctx.env, "DISCORD_BOT_TOKEN") && getEnv(ctx.env, "DISCORD_DM_USER_ID")) return "bot-dm";
  return null;
}

function buildContent(msg: DeliveryMessage): string {
  let content = `**${msg.title}**\n\n${msg.body}`;
  if (content.length > CONTENT_LIMIT) {
    content = content.slice(0, CONTENT_LIMIT) + "\n…(truncated — full report lives in the brain repo)";
  }
  return content;
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
    const content = buildContent(msg);
    const via = mode(ctx);

    if (via === "webhook") {
      const res = await doFetch(getEnv(ctx.env, "DISCORD_WEBHOOK_URL")!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, ...(msg.sender ? { username: msg.sender } : {}) }),
      });
      if (!res.ok) {
        throw new Error(`discord webhook → HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
      }
      return { channel: "discord", ok: true, detail: `webhook: posted ${content.length} chars` };
    }

    // bot-DM mode
    const auth = { Authorization: `Bot ${getEnv(ctx.env, "DISCORD_BOT_TOKEN")!}`, "Content-Type": "application/json" };
    const dmRes = await doFetch(`${API}/users/@me/channels`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ recipient_id: getEnv(ctx.env, "DISCORD_DM_USER_ID")! }),
    });
    if (!dmRes.ok) {
      throw new Error(`discord DM open → HTTP ${dmRes.status} ${await dmRes.text().catch(() => "")}`.trim());
    }
    const { id: channelId } = (await dmRes.json()) as { id: string };

    const sendRes = await doFetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content }),
    });
    if (!sendRes.ok) {
      throw new Error(`discord DM send → HTTP ${sendRes.status} ${await sendRes.text().catch(() => "")}`.trim());
    }
    return { channel: "discord", ok: true, detail: `bot DM: sent ${content.length} chars` };
  },
};
