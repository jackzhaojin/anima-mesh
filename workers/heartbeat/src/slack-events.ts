import type { Env } from "./env.js";
import { cleanSlackText, slackApi, slackIdList, slackSenderAllowed } from "../../../src/channels/slack.js";

/**
 * Slack Events API endpoint - the mesh's ear in a group setting (v2.3).
 * Same shape as the Discord interactions route: a webhook, never a socket
 * (Socket Mode would be a long connection - D7). Slack POSTs here; every
 * request is HMAC-verified against the app's signing secret, with a
 * five-minute replay window, before anything else looks at it.
 *
 * Flow: verify → url_verification handshake → event filter → sender gate
 * → channel gate → budget + dedup (in the DO) → enqueue → 200 inside
 * Slack's 3-second window. The DirectionDO alarm does the thinking and
 * replies in the mention's thread.
 *
 * Inbound events: `app_mention` (someone @-mentions the persona in a
 * channel it was invited to) and `message` with channel_type "im" (a DM to
 * the app). Everything else - edits, joins, and EVERY bot-authored message
 * - is acknowledged and dropped. Ignoring bots is what keeps two agents in
 * one channel from talking each other into a loop.
 *
 * Sender policy: only SLACK_ALLOWED_USER_IDS may direct the persona; absent
 * means nobody, so a fresh install answers no one until the operator opts
 * people in. `*` hands the list to Slack's channel membership, for the
 * channels SLACK_ALLOWED_CHANNEL_IDS pins only (slackSenderAllowed). Strangers get no reply - the attempt is recorded and folded
 * into the ledger with the next drain, exactly like a Discord knock.
 * SLACK_ALLOWED_CHANNEL_IDS optionally pins which shared channels the
 * persona answers in; it is the code-level answer to "which rooms may hear
 * from this brain".
 */

const REPLAY_WINDOW_S = 300;

interface SlackEvent {
  type?: string;
  subtype?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
}

interface SlackEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackEvent;
  authorizations?: Array<{ user_id?: string; is_bot?: boolean }>;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 per Slack's spec: `v0=` + hex(HMAC(secret, `v0:{ts}:{body}`)). */
export async function verifySlackSignature(
  signingSecret: string,
  signature: string | null,
  timestamp: string | null,
  body: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!signingSecret || !signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > REPLAY_WINDOW_S) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const expected = enc.encode(`v0=${hex(await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${body}`)))}`);
  const given = enc.encode(signature);
  if (given.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, expected);
}

const OK = () => new Response(null, { status: 200 });

export async function handleSlackEvent(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await req.text();
  const ok = await verifySlackSignature(
    env.SLACK_SIGNING_SECRET ?? "",
    req.headers.get("x-slack-signature"),
    req.headers.get("x-slack-request-timestamp"),
    body,
  );
  if (!ok) return new Response("invalid request signature", { status: 401 });

  const envelope = JSON.parse(body) as SlackEnvelope;
  if (envelope.type === "url_verification") return Response.json({ challenge: envelope.challenge ?? "" });
  if (envelope.type !== "event_callback" || !envelope.event) return OK();

  const event = envelope.event;
  const isDm = event.type === "message" && event.channel_type === "im";
  if (event.type !== "app_mention" && !isDm) return OK();
  // Bots (this one included), edits, joins, deletions: never directions.
  if (event.bot_id || event.subtype || !event.user || !event.channel || !event.ts) return OK();
  const botUserId = envelope.authorizations?.find((a) => a.is_bot)?.user_id ?? envelope.authorizations?.[0]?.user_id;
  if (botUserId && event.user === botUserId) return OK();

  const stub = env.DIRECTION_DO.get(env.DIRECTION_DO.idFromName("main"));
  const gateEnv = {
    SLACK_ALLOWED_USER_IDS: env.SLACK_ALLOWED_USER_IDS,
    SLACK_ALLOWED_CHANNEL_IDS: env.SLACK_ALLOWED_CHANNEL_IDS,
  };
  const pinned = slackIdList(env.SLACK_ALLOWED_CHANNEL_IDS);
  const channelOk = isDm || pinned.length === 0 || pinned.includes(event.channel); // for the denial record only
  if (!slackSenderAllowed(gateEnv, { user: event.user, channel: event.channel, isDm })) {
    // Silent to the sender; evidence for the principal.
    await stub.fetch("https://do/denied", {
      method: "POST",
      body: JSON.stringify({
        channel: "slack",
        sender: channelOk ? event.user : `${event.user} in ${event.channel}`,
        receivedAt: new Date().toISOString(),
      }),
    });
    return OK();
  }

  const text = cleanSlackText(event.text ?? "", botUserId);
  if (!text) return OK(); // a bare mention carries nothing to act on

  const api = { env: { SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN } };
  const enqueue = await stub.fetch("https://do/enqueue", {
    method: "POST",
    body: JSON.stringify({
      message: {
        channel: "slack",
        sender: event.user,
        text,
        receivedAt: new Date().toISOString(),
        messageId: event.ts,
        audience: isDm ? "direct" : "group",
      },
      slack: {
        channel: event.channel,
        ts: event.ts,
        // A DM answers in-line; a channel mention answers in its thread.
        ...(isDm ? (event.thread_ts ? { threadTs: event.thread_ts } : {}) : { threadTs: event.thread_ts ?? event.ts }),
        ...(event.thread_ts ? { inThread: true } : {}),
        ...(botUserId ? { botUserId } : {}),
      },
      // Slack retries an event it thinks we missed; one event = one run.
      dedupKey: envelope.event_id ? `slack:${envelope.event_id}` : `slack:${event.channel}:${event.ts}`,
    }),
  });

  if (enqueue.status === 429) {
    const { cap } = (await enqueue.json()) as { cap: number };
    ctx.waitUntil(
      slackApi(api, "chat.postEphemeral", {
        channel: event.channel,
        user: event.user,
        text: `Direction budget reached for today (${cap}). Not processed - mention me again tomorrow if it still matters.`,
        ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      }).catch((err) => console.log(`slack budget notice failed: ${err instanceof Error ? err.message : String(err)}`)),
    );
    return OK();
  }

  if (enqueue.status === 202) {
    // "Seen, thinking" - the Slack analogue of Discord's deferred state.
    ctx.waitUntil(
      slackApi(api, "reactions.add", { channel: event.channel, timestamp: event.ts, name: "eyes" }).catch((err) =>
        console.log(`slack ack reaction failed: ${err instanceof Error ? err.message : String(err)}`),
      ),
    );
  }
  return OK();
}
