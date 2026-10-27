/**
 * Delivery channels — how the mesh's reports reach the principal. Same
 * philosophy as the provider chokepoint: one thin seam, swappable adapters,
 * secrets referenced by env-var name and never held by the engine.
 *
 * Delivering to the principal's own sanctioned channels is the needs-you
 * surface, not external publishing — publishing to the world remains a
 * constitution-gated action regardless of channel.
 */
export interface DeliveryMessage {
  title: string;
  body: string;
  /** Display name of the sender (the mesh persona, typically). */
  sender?: string;
  /** Recipient address where the channel needs one (email). */
  recipient?: string;
  /**
   * Follow-up detail (v2.3.5 brief digest: the Also list and the report
   * link). Threading channels post it as a reply under the first message so
   * the notification itself stays short; others append it to the body.
   */
  thread?: string;
}

/** Body and thread as one text, for channels that cannot thread. */
export function flatBody(msg: DeliveryMessage): string {
  return msg.thread ? `${msg.body}\n\n${msg.thread}` : msg.body;
}

export interface ChannelContext {
  env: Record<string, string | undefined>;
  /** Injectable for the regression suite; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  log?: (note: string) => void;
}

export interface DeliveryResult {
  channel: string;
  ok: boolean;
  detail: string;
}

export interface DeliveryChannel {
  readonly name: string;
  /** Throws with a setup hint (naming the missing env var) when unconfigured. */
  assertConfigured(ctx: ChannelContext): void;
  deliver(msg: DeliveryMessage, ctx: ChannelContext): Promise<DeliveryResult>;
}
