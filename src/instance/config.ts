import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { CONFIG_FILENAME, DEFAULT_CONFIG, type InstanceConfig } from "./config-core.js";

export { CONFIG_FILENAME, DEFAULT_CONFIG, type InstanceConfig } from "./config-core.js";

/**
 * An instance ("a brain") is any directory holding an animamesh.config.json
 * plus an OKF bundle. The engine consumes it strictly by configuration —
 * it knows nothing about any particular firm (D12).
 */
export interface ResolvedInstance {
  root: string;
  config: InstanceConfig;
  bundleDir: string;
  ledgerFile: string;
  approvalsDir: string;
  reportsDir: string;
  draftsDir: string;
}

export function loadInstance(instanceRoot: string): ResolvedInstance {
  const root = path.resolve(instanceRoot);
  const configPath = path.join(root, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    throw new Error(`no ${CONFIG_FILENAME} found in ${root} — is this an AnimaMesh instance?`);
  }
  const config = { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(configPath, "utf8")) as Partial<InstanceConfig>) };
  return {
    root,
    config,
    bundleDir: path.join(root, config.bundle),
    ledgerFile: path.join(root, config.ledger),
    approvalsDir: path.join(root, config.approvals),
    reportsDir: path.join(root, config.reports),
    draftsDir: path.join(root, config.drafts),
  };
}
