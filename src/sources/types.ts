/**
 * Read sources — external document stores an agent's prompt context can be
 * assembled from. Same philosophy as channels: one thin seam, fetch-based
 * adapters, secrets referenced by env-var name and never held by the engine.
 *
 * Sources are READ-ONLY by construction: an adapter exposes listing and
 * content reads and nothing else. Anything that writes to the outside world
 * is a channel or a gated action, never a source.
 */
export interface SourceContext {
  env: Record<string, string | undefined>;
  /** Injectable for the regression suite; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  log?: (note: string) => void;
}
