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
  /**
   * Cognition overrides — the "which brain, today" knob. Agent frontmatter
   * stays the declared identity (harness + model, with git history); this
   * block REDIRECTS a declared harness to another at run time, so vendor
   * outages/blocks are one config edit, not frontmatter churn. Delete the
   * entry to fall back to the declaration. (Born 2026-07-11: the Kimi edge
   * blocks Workers egress; agents keep `moonshot-api` declared while
   * actually running `anthropic-api` until Kimi is reachable again.)
   */
  cognition?: {
    overrides?: Record<string, { harness?: string; model?: string }>;
  };
  /**
   * Inbound direction: messages addressed to the mesh's persona become
   * agentic runs (the model decides the disposition — never a keyword
   * router). Sender allowlists live at the channel edge (Worker secrets /
   * `gmail.allowedFrom`); this block is behavior only.
   */
  direction?: {
    /** Which agent processes directions. Default: delivery.deliverAgent ?? "chief-of-staff". */
    agent?: string;
    /** Max direction runs per local calendar day. Default 20. */
    dailyCap?: number;
    gmail?: {
      /** Poll cadence in minutes; 0/absent = inbound email off. */
      pollMinutes?: number;
      /** Only messages from this address become directions. */
      allowedFrom?: string;
    };
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
