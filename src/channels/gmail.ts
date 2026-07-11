import type { DeliveryChannel, DeliveryMessage, ChannelContext, DeliveryResult } from "./types.js";
import { getEnv } from "../instance/env-core.js";

/**
 * Gmail delivery via OAuth refresh token — the persona sends from its own
 * account. Requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
 * AGENT_EMAIL (the sending identity), and a recipient on the message.
 * No SDK: token refresh + RFC822 raw send over plain fetch.
 */
export const gmailChannel: DeliveryChannel = {
  name: "gmail",

  assertConfigured(ctx: ChannelContext): void {
    for (const key of ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "AGENT_EMAIL"]) {
      if (!getEnv(ctx.env, key)) throw new Error(`gmail channel: ${key} is not set`);
    }
  },

  async deliver(msg: DeliveryMessage, ctx: ChannelContext): Promise<DeliveryResult> {
    if (!msg.recipient) throw new Error("gmail channel: message has no recipient");
    const doFetch = ctx.fetchImpl ?? fetch;
    const from = getEnv(ctx.env, "AGENT_EMAIL")!;

    const tokenRes = await doFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: getEnv(ctx.env, "GMAIL_CLIENT_ID")!,
        client_secret: getEnv(ctx.env, "GMAIL_CLIENT_SECRET")!,
        refresh_token: getEnv(ctx.env, "GMAIL_REFRESH_TOKEN")!,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!tokenRes.ok) {
      throw new Error(`gmail token refresh → HTTP ${tokenRes.status} ${await tokenRes.text().catch(() => "")}`.trim());
    }
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    const fromHeader = msg.sender ? `${msg.sender} <${from}>` : from;
    const rfc822 = [
      `From: ${fromHeader}`,
      `To: ${msg.recipient}`,
      `Subject: ${msg.title}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      msg.body,
    ].join("\r\n");
    const raw = Buffer.from(rfc822, "utf8").toString("base64url");

    const sendRes = await doFetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!sendRes.ok) {
      throw new Error(`gmail send → HTTP ${sendRes.status} ${await sendRes.text().catch(() => "")}`.trim());
    }
    return { channel: "gmail", ok: true, detail: `sent to ${msg.recipient}` };
  },
};
