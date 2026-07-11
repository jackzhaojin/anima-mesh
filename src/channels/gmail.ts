import type { DeliveryChannel, DeliveryMessage, ChannelContext, DeliveryResult } from "./types.js";
import { getEnv } from "../instance/env-core.js";

/**
 * Gmail, both directions, via OAuth refresh token — the persona's own
 * account. Requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
 * AGENT_EMAIL. No SDK, no node built-ins — pure fetch + Web platform (this
 * module runs on Workers: the DirectionDO polls the inbox).
 *
 * Outbound (deliver) needs the gmail.send scope. Inbound (pollGmailInbox /
 * markGmailRead) needs gmail.modify — a refresh token consented for send
 * only will 403 on the poll; re-consent is an instance act.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

// ---- Web-platform base64url (Workers have no Buffer) ------------------------

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(data: string): string {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---- OAuth -------------------------------------------------------------------

async function accessToken(ctx: ChannelContext): Promise<string> {
  const doFetch = ctx.fetchImpl ?? fetch;
  const res = await doFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: getEnv(ctx.env, "GMAIL_CLIENT_ID")!,
      client_secret: getEnv(ctx.env, "GMAIL_CLIENT_SECRET")!,
      refresh_token: getEnv(ctx.env, "GMAIL_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`gmail token refresh → HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

function assertGmailEnv(ctx: ChannelContext): void {
  for (const key of ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "AGENT_EMAIL"]) {
    if (!getEnv(ctx.env, key)) throw new Error(`gmail channel: ${key} is not set`);
  }
}

// ---- outbound ----------------------------------------------------------------

export const gmailChannel: DeliveryChannel = {
  name: "gmail",

  assertConfigured(ctx: ChannelContext): void {
    assertGmailEnv(ctx);
  },

  async deliver(msg: DeliveryMessage, ctx: ChannelContext): Promise<DeliveryResult> {
    if (!msg.recipient) throw new Error("gmail channel: message has no recipient");
    const doFetch = ctx.fetchImpl ?? fetch;
    const from = getEnv(ctx.env, "AGENT_EMAIL")!;
    const token = await accessToken(ctx);

    const fromHeader = msg.sender ? `${msg.sender} <${from}>` : from;
    const rfc822 = [
      `From: ${fromHeader}`,
      `To: ${msg.recipient}`,
      `Subject: ${msg.title}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      msg.body,
    ].join("\r\n");

    const sendRes = await doFetch(`${GMAIL_API}/messages/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: base64UrlEncode(rfc822) }),
    });
    if (!sendRes.ok) {
      throw new Error(`gmail send → HTTP ${sendRes.status} ${await sendRes.text().catch(() => "")}`.trim());
    }
    return { channel: "gmail", ok: true, detail: `sent to ${msg.recipient}` };
  },
};

// ---- inbound (the direction poll) ---------------------------------------------

export interface InboundEmail {
  id: string;
  from: string;
  subject: string;
  text: string;
  receivedAt: string;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function findPlainPart(part: GmailPart): string {
  if (part.mimeType === "text/plain" && part.body?.data) return base64UrlDecode(part.body.data);
  for (const p of part.parts ?? []) {
    const found = findPlainPart(p);
    if (found) return found;
  }
  return "";
}

function plainText(part: GmailPart | undefined): string {
  if (!part) return "";
  // Fall back to the top-level body ONLY when no text/plain part exists —
  // a per-part fallback would happily return the text/html sibling.
  return findPlainPart(part) || (part.body?.data ? base64UrlDecode(part.body.data) : "");
}

function header(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * Unread mail from exactly one allowed sender (the principal — decision Q6).
 * The query filters server-side; the From header is re-checked client-side
 * (defense against loose query matching). Messages stay unread until the
 * caller confirms processing with markGmailRead — mark-read IS the dedup.
 */
export async function pollGmailInbox(
  ctx: ChannelContext,
  opts: { allowedFrom: string; maxMessages?: number },
): Promise<InboundEmail[]> {
  assertGmailEnv(ctx);
  if (!opts.allowedFrom) throw new Error("gmail poll: allowedFrom is required — inbound is allowlist-only");
  const doFetch = ctx.fetchImpl ?? fetch;
  const token = await accessToken(ctx);
  const auth = { Authorization: `Bearer ${token}` };

  const q = encodeURIComponent(`from:${opts.allowedFrom} is:unread in:inbox`);
  const listRes = await doFetch(`${GMAIL_API}/messages?q=${q}&maxResults=${opts.maxMessages ?? 5}`, {
    headers: auth,
  });
  if (!listRes.ok) {
    throw new Error(`gmail list → HTTP ${listRes.status} ${await listRes.text().catch(() => "")}`.trim());
  }
  const list = (await listRes.json()) as { messages?: Array<{ id: string }> };

  const out: InboundEmail[] = [];
  for (const m of list.messages ?? []) {
    const msgRes = await doFetch(`${GMAIL_API}/messages/${m.id}?format=full`, { headers: auth });
    if (!msgRes.ok) continue; // one bad message must not kill the poll
    const msg = (await msgRes.json()) as {
      id: string;
      internalDate?: string;
      payload?: GmailPart & { headers?: Array<{ name: string; value: string }> };
    };
    const from = header(msg.payload?.headers, "From");
    if (!from.toLowerCase().includes(opts.allowedFrom.toLowerCase())) continue; // client-side re-check
    out.push({
      id: msg.id,
      from,
      subject: header(msg.payload?.headers, "Subject"),
      text: plainText(msg.payload).trim(),
      receivedAt: msg.internalDate
        ? new Date(Number(msg.internalDate)).toISOString()
        : new Date().toISOString(),
    });
  }
  return out;
}

/** Confirm processing: drop UNREAD so the next poll never sees this message. */
export async function markGmailRead(ctx: ChannelContext, messageId: string): Promise<void> {
  const doFetch = ctx.fetchImpl ?? fetch;
  const token = await accessToken(ctx);
  const res = await doFetch(`${GMAIL_API}/messages/${messageId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  });
  if (!res.ok) {
    throw new Error(`gmail modify → HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
}
