import type { Env } from "./env.js";

/**
 * Discord Interactions endpoint — the mesh's inbound ear (decision Q3a:
 * webhook, never a gateway socket; D7 forbids long connections). Discord
 * POSTs here; every request is Ed25519-verified against the app's public
 * key before anything else looks at it.
 *
 * Flow: verify → PING/PONG → sender gate → budget gate (in the DO) →
 * enqueue → deferred response (type 5) inside Discord's 3-second window.
 * The DirectionDO alarm does the thinking afterwards and replies via the
 * interaction followup webhook.
 *
 * Sender policy (decision Q5): only the configured principal
 * (DISCORD_DM_USER_ID) may direct the mesh. Strangers get NO interaction
 * response — Discord shows them a generic "did not respond", indistinguishable
 * from a dead bot — and the attempt is recorded in the DO, folded into the
 * ledger with the next flush (never a commit per knock).
 */

interface InteractionOption {
  name: string;
  type: number;
  value?: unknown;
  options?: InteractionOption[];
}

interface Interaction {
  type: number;
  id: string;
  application_id: string;
  token: string;
  data?: { name?: string; options?: InteractionOption[] };
  member?: { user?: { id?: string } };
  user?: { id?: string };
}

const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = { type: 1 };
const EPHEMERAL = 64;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Ed25519 verify per Discord's spec: signature over timestamp + raw body. */
export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string | null,
  timestamp: string | null,
  body: string,
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signatureHex),
      new TextEncoder().encode(timestamp + body),
    );
  } catch {
    return false;
  }
}

/** All string option values, depth-first — the free-text of the command. */
function commandText(options: InteractionOption[] | undefined): string {
  if (!options) return "";
  const parts: string[] = [];
  for (const o of options) {
    if (typeof o.value === "string") parts.push(o.value);
    if (o.options) parts.push(commandText(o.options));
  }
  return parts.filter(Boolean).join("\n");
}

export async function handleInteraction(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  const ok = await verifyDiscordSignature(
    env.DISCORD_PUBLIC_KEY ?? "",
    req.headers.get("x-signature-ed25519"),
    req.headers.get("x-signature-timestamp"),
    body,
  );
  if (!ok) return new Response("invalid request signature", { status: 401 });

  const interaction = JSON.parse(body) as Interaction;
  if (interaction.type === PING) return Response.json(PONG);
  if (interaction.type !== APPLICATION_COMMAND) return new Response("unsupported", { status: 400 });

  const senderId = interaction.member?.user?.id ?? interaction.user?.id ?? "";
  const stub = env.DIRECTION_DO.get(env.DIRECTION_DO.idFromName("main"));

  if (!env.DISCORD_DM_USER_ID || senderId !== env.DISCORD_DM_USER_ID) {
    // Silent to the sender; evidence for the principal (Q5).
    await stub.fetch("https://do/denied", {
      method: "POST",
      body: JSON.stringify({ channel: "discord", sender: senderId, receivedAt: new Date().toISOString() }),
    });
    return new Response(null, { status: 202 });
  }

  const text = commandText(interaction.data?.options).trim();
  if (!text) {
    return Response.json({
      type: 4,
      data: { content: "Nothing to act on — give me a message.", flags: EPHEMERAL },
    });
  }

  const enqueue = await stub.fetch("https://do/enqueue", {
    method: "POST",
    body: JSON.stringify({
      message: {
        channel: "discord",
        sender: senderId,
        text,
        receivedAt: new Date().toISOString(),
        messageId: interaction.id,
      },
      followup: { applicationId: interaction.application_id, token: interaction.token },
    }),
  });

  if (enqueue.status === 429) {
    const { cap } = (await enqueue.json()) as { cap: number };
    return Response.json({
      type: 4,
      data: {
        content: `Direction budget reached for today (${cap}). Recorded, not processed — it will surface in tomorrow's brief.`,
        flags: EPHEMERAL,
      },
    });
  }

  // Deferred: Discord shows "thinking…" until the DO's followup lands.
  return Response.json({ type: 5 });
}
