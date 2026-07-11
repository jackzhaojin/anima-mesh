import { existsSync } from "node:fs";
import * as path from "node:path";
import type { LinkChecker } from "./conformance.js";

/**
 * Disk-fidelity R4 link checker for filesystem bundles: resolves against
 * the concept's absolute path — links to any existing file (even outside
 * the bundle) pass, exactly the pre-seam behavior. Node-only.
 */
export const diskLinkChecker: LinkChecker = (concept, target) =>
  existsSync(path.resolve(path.dirname(concept.path), target));
