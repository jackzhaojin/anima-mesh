import "../providers/node-providers.js"; // register subprocess providers (Node entrypoint)
import type { InstanceStore } from "../instance/store.js";
import { FsInstanceStore } from "../instance/store-fs.js";
import { nodeSourceFs } from "../sources/local-files.js";
import { runAgentCore, type RunCoreOptions, type RunReport } from "./run-core.js";

export type { RunReport } from "./run-core.js";

/**
 * Node convenience wrapper over run-core: defaults the store to the local
 * filesystem and ensures CLI providers are registered. Workers import
 * run-core directly and pass a remote store.
 */
export interface RunOptions extends Omit<RunCoreOptions, "store"> {
  /** Filesystem instance root; ignored when `store` is provided. */
  instanceRoot?: string;
  /** The storage seam. Default: FsInstanceStore(instanceRoot). */
  store?: InstanceStore;
}

export async function runAgent(options: RunOptions): Promise<RunReport> {
  const { instanceRoot, store, ...rest } = options;
  const resolved =
    store ??
    (() => {
      if (!instanceRoot) throw new Error("runAgent: provide `store` or `instanceRoot`");
      return new FsInstanceStore(instanceRoot);
    })();
  // Node tier: sources may read local working trees (caller can still override).
  return runAgentCore({ sourceFs: nodeSourceFs, ...rest, store: resolved });
}
