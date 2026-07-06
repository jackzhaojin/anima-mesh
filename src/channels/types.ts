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
