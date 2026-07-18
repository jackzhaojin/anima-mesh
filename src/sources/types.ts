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
  /**
   * Local-filesystem capability, injected by the Node/CLI harness only —
   * Workers never set it, so fetch-based access paths remain the only ones
   * reachable there and the import graph stays free of node built-ins.
   */
  sourceFs?: SourceFs;
}

/** One file in a local working-tree listing. Path is root-relative. */
export interface LocalFileEntry {
  path: string;
  size: number;
  /** ISO instant of last modification. */
  lastModified?: string;
}

/** The injectable local-read capability (implementation: sources/local-files.ts, Node tier). */
export interface SourceFs {
  listFiles(
    rootAbs: string,
    opts: { excludes: string[]; maxEntries: number },
  ): Promise<{ entries: LocalFileEntry[]; truncated: boolean }>;
  /** UTF-8 content of one file under a previously listed root. */
  readTextFile(rootAbs: string, relPath: string): Promise<string>;
}
