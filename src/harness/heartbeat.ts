import "../providers/node-providers.js"; // register subprocess providers (Node entrypoint)
import type { InstanceStore } from "../instance/store.js";
import { FsInstanceStore } from "../instance/store-fs.js";
import { nodeSourceFs } from "../sources/local-files.js";
import { heartbeatCore, type HeartbeatCoreOptions, type HeartbeatResult } from "./heartbeat-core.js";

export {
  PERIOD_HOURS,
  type HeartbeatDecision,
  type HeartbeatFailure,
  type HeartbeatResult,
} from "./heartbeat-core.js";

/**
 * Node convenience wrapper over heartbeat-core: defaults the store to the
 * local filesystem and ensures CLI providers are registered. Workers import
 * heartbeat-core directly with a remote store.
 */
export interface HeartbeatOptions extends Omit<HeartbeatCoreOptions, "store"> {
  /** Filesystem instance root; ignored when `store` is provided. */
  instanceRoot?: string;
  /** The storage seam. Default: FsInstanceStore(instanceRoot). */
  store?: InstanceStore;
}

export async function heartbeat(options: HeartbeatOptions): Promise<HeartbeatResult> {
  const { instanceRoot, store, ...rest } = options;
  const resolved =
    store ??
    (() => {
      if (!instanceRoot) throw new Error("heartbeat: provide `store` or `instanceRoot`");
      return new FsInstanceStore(instanceRoot);
    })();
  // Node tier: sources may read local working trees (caller can still override).
  return heartbeatCore({ sourceFs: nodeSourceFs, ...rest, store: resolved });
}
