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
}

export interface ProviderResult {
  text: string;
  raw?: unknown;
  tokens?: unknown;
  costUsd?: number;
}

export interface AgentWorkerProvider {
  readonly name: string;
  /** Throws with a setup hint when the harness/env is missing. */
  assertConfigured(): void;
  run(opts: ProviderRunOptions): Promise<ProviderResult>;
}
