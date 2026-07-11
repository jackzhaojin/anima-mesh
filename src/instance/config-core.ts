/**
 * Instance config shape + defaults — Workers-safe (no node built-ins).
 * Disk loading (loadInstance) lives in config.ts.
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

export const CONFIG_FILENAME = "animamesh.config.json";

export const DEFAULT_CONFIG: InstanceConfig = {
  bundle: "bundle",
  ledger: "ledger/actions.jsonl",
  approvals: "approvals",
  reports: "reports",
  drafts: "drafts",
};
