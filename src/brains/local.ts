import { existsSync } from "node:fs";
import * as path from "node:path";
import { CONFIG_FILENAME } from "../instance/config.js";
import { FsInstanceStore } from "../instance/store-fs.js";
import type { LocalBrainOpener } from "../sources/types.js";

/**
 * Node-tier opener for linked brains' local checkouts: `link.localPath`
 * resolves against THIS instance's root (sibling checkouts like
 * ../brain-<id> are the convention). Returns undefined when no brain lives
 * there, so the source can say so out loud. Node-only - never reachable
 * from the Worker bundle (enforced by workers-imports.test).
 *
 * The opener hands back a plain fs store; the 'brains' source wraps it
 * read-only before anything touches it.
 */
export function localBrainOpener(instanceRoot: string | undefined): LocalBrainOpener {
  return (link) => {
    if (!instanceRoot || !link.localPath) return undefined;
    const abs = path.resolve(instanceRoot, link.localPath);
    if (!existsSync(path.join(abs, CONFIG_FILENAME))) return undefined;
    return new FsInstanceStore(abs);
  };
}
