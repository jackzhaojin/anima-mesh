import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * An instance ("a brain") is any directory holding an animamesh.config.json
 * plus an OKF bundle. The engine consumes it strictly by configuration —
 * it knows nothing about any particular firm (D12).
 */
export interface InstanceConfig {
  /** Relative path to the OKF bundle dir. */
  bundle: string;
  /** Relative path to the append-only action ledger (JSONL). */
  ledger: string;
  /** Relative path to the approvals dir (needs-you surface). */
  approvals: string;
  /** Relative path where run reports land. */
  reports: string;
  /** Relative path where L2+ drafts land. */
  drafts: string;
  engine?: { repo?: string; ref?: string };
  identity?: {
    principal: { name: string; email?: string };
    persona?: { name: string; emails?: string[] };
  };
  /** D11 dual-gate state for commercial agents. Flipped by humans, read by code. */
  activation?: {
    boundaryMapVerified?: boolean;
    optionTrigger?: string | null;
    founderWaiver?: boolean;
  };
  /** Where reports get delivered (channel names) and whose report is "the brief". */
  delivery?: {
    channels?: string[];
    deliverAgent?: string;
  };
  /** A2A surface config; url is where the Agent Card would be served when hosted. */
  a2a?: {
    url?: string;
  };
}

export interface ResolvedInstance {
  root: string;
  config: InstanceConfig;
  bundleDir: string;
  ledgerFile: string;
  approvalsDir: string;
  reportsDir: string;
  draftsDir: string;
}

export const CONFIG_FILENAME = "animamesh.config.json";

export const DEFAULT_CONFIG: InstanceConfig = {
  bundle: "bundle",
  ledger: "ledger/actions.jsonl",
  approvals: "approvals",
  reports: "reports",
  drafts: "drafts",
};

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
