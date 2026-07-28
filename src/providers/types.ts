/**
 * The AgentWorkerProvider chokepoint (D14): one thin seam behind which every
 * model+harness combination lives. Each agent's concept file declares its
 * `model` and `harness`; swapping either is a config edit, never a rebuild.
 *
 * Pattern lineage: the migration-agent backend seam — "one contract,
 * swappable runtimes" — proven across Claude, Codex, and Kimi backends.
 */
export interface ProviderRunOptions {
  prompt: string;
  /** Working directory the harness grants the worker. */
  cwd: string;
  /** Model identifier in the harness's own vocabulary (from the agent concept). */
  model?: string;
  timeoutMs?: number;
  onProgress?: (note: string) => void;
  /**
   * Web searches this run may spend (from the agent concept's `web:` field).
   * Providers WITHOUT `capabilities.webSearch` ignore it — the prompt, not
   * the provider, is where that gap is disclosed to the agent.
   */
  webSearchMaxUses?: number;
}

export interface ProviderResult {
  text: string;
  raw?: unknown;
  tokens?: unknown;
  costUsd?: number;
  /**
   * Capability the run ASKED for but did not get, with the reason — e.g. the
   * gateway rejecting server-side web search. The harness surfaces it in
   * progress and the ledger; the prompt already told the agent to report the
   * gap rather than treat unchecked as unchanged.
   */
  degraded?: string;
}

/**
 * What a harness can actually DO for the worker it runs. Declared per
 * provider and stated verbatim in the prompt, because the alternative is the
 * failure this exists to prevent: an agent told to "budget ~8 web fetches"
 * on a harness that sends no tools at all reads its own inability as "the
 * tool returned nothing" and reports unchecked subjects as unchanged
 * (engine issue #4, two cloud runs, 2026-07-25/26).
 *
 * Absent ⇒ nothing is claimed. Under-claiming costs a sentence of prompt;
 * over-claiming costs a silently fabricated week of research.
 */
export interface ProviderCapabilities {
  /** The worker can read files under `cwd` with its own tools (subprocess tiers). */
  fileReads: boolean;
  /** The worker can search the live web mid-run. */
  webSearch: boolean;
}

/** The honest default: a provider that declares nothing offers nothing. */
export const NO_CAPABILITIES: ProviderCapabilities = { fileReads: false, webSearch: false };

export interface AgentWorkerProvider {
  readonly name: string;
  /**
   * What this harness grants the worker. Optional so a third-party or test
   * provider still type-checks — undeclared reads as NO_CAPABILITIES.
   */
  readonly capabilities?: ProviderCapabilities;
  /** Throws with a setup hint when the harness/env is missing. */
  assertConfigured(): void;
  run(opts: ProviderRunOptions): Promise<ProviderResult>;
}

export function providerCapabilities(provider: AgentWorkerProvider): ProviderCapabilities {
  return provider.capabilities ?? NO_CAPABILITIES;
}
