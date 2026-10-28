/**
 * Instance config shape + defaults — Workers-safe (no node built-ins).
 * Disk loading (loadInstance) lives in config.ts.
 */

/**
 * What a brain models - framing for prompts and scaffolds, never safety
 * (safety is links + share markings + gates, all enforced in code):
 * - person: one human's life (the digital twin of a principal)
 * - org:    a company or other organization
 * - team:   a unit inside an org
 * - group:  any other shared space (a family, a community, a project)
 */
export type BrainKind = "person" | "org" | "team" | "group";

/**
 * This brain's relationship TO a linked brain - read as
 * "<this brain> <relation> <linked brain>":
 * - member-of / has-member: a person belongs to an org/team/group
 * - child-of / parent-of:   containment (a team inside its org); the
 *                            parent's constitution binds the child
 * - peer-of:                lateral (partner orgs, two people)
 * A link is live only when BOTH brains declare it with inverse relations.
 */
export type BrainRelation = "member-of" | "has-member" | "child-of" | "parent-of" | "peer-of";

/** Who this brain is - the handle links and `share:` markings use. */
export interface BrainIdentity {
  /** Lowercase slug (a-z, 0-9, hyphens), unique across the brains it links to. */
  id: string;
  kind: BrainKind;
  /** Display name. */
  name?: string;
}

/** A typed connection to another brain (declared on both sides). */
export interface BrainLinkConfig {
  /** The linked brain's own `brain.id`. */
  id: string;
  /** This brain's relationship to the linked one (see BrainRelation). */
  relation: BrainRelation;
  /** Free-text role on a membership (owner, founder, advisor, …). Informational. */
  role?: string;
  /** Laptop transport: a local checkout of the linked brain, relative to this instance root. */
  localPath?: string;
  /** Cloud transport: the linked brain's repo, "owner/name". */
  repo?: string;
  /** Branch of `repo`. Default "main". */
  ref?: string;
  /**
   * Env var holding a READ-ONLY token for `repo`. Default
   * BRAIN_LINK_<ID>_TOKEN. Never falls back to this brain's own
   * GITHUB_TOKEN: a link gets its own least-privilege credential.
   */
  tokenEnv?: string;
  /** What THIS brain gives the linked one beyond `share:` markings. */
  grants?: {
    /** Export the hub's latest brief (the delivery agent's newest report). */
    brief?: boolean;
    /**
     * Mandatory markings this link is cleared for. A concept carrying
     * `markings: [finance]` crosses ONLY links that list `finance` here -
     * even when its `share:` names the reader. Absent ⇒ cleared for none.
     */
    markings?: string[];
  };
}

/**
 * Multi-player roles. owner: amends the constitution, decides any approval;
 * approver: decides approvals; contributor: directs the mesh; viewer: reads.
 */
export type MemberRole = "owner" | "approver" | "contributor" | "viewer";

/** One human who acts in this brain. */
export interface MemberConfig {
  /** Lowercase slug; what `gate approve --by` names. */
  id: string;
  name: string;
  email?: string;
  role: MemberRole;
  /** The member's own (person) brain, when linked via `has-member`. */
  brain?: string;
}

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
    /**
     * Multi-player: every human who acts in this brain, with a role.
     * Absent ⇒ the principal alone, as owner (the single-player default).
     */
    members?: MemberConfig[];
  };
  /** Who this brain is. Required before it may link to another brain. */
  brain?: BrainIdentity;
  /** Typed connections to other brains - the layering (see docs/layered-brains.md). */
  links?: BrainLinkConfig[];
  /** D11 dual-gate state for commercial agents. Flipped by humans, read by code. */
  activation?: {
    boundaryMapVerified?: boolean;
    optionTrigger?: string | null;
    founderWaiver?: boolean;
  };
  /**
   * "local" (v2.3.6): nothing leaves this machine except the model call. The
   * engine refuses chat/mail delivery, network read sources, web search,
   * public engine issues and the cloud tier for this brain (local-mode.ts).
   */
  mode?: "local";
  /**
   * Where the brain lives (v2.3.7). "git" (default): a repository; git
   * merges and keeps history. "synced": a folder a sync client keeps on each
   * machine (OneDrive, SharePoint, Google Drive, Dropbox) - every machine
   * writes its own ledger shard, writes are atomic, conflict copies are
   * flagged, and only the `runner` machine runs scheduled beats
   * (docs/storage.md). The cloud tier needs git.
   */
  storage?: {
    kind?: "git" | "synced";
    provider?: "onedrive" | "google-drive" | "dropbox" | "other";
    /** The one machine (host name or ANIMAMESH_WRITER) that runs `heartbeat`. */
    runner?: string;
  };
  /** Where reports get delivered (channel names) and whose report is "the brief". */
  delivery?: {
    channels?: string[];
    deliverAgent?: string;
    /**
     * How the hub's brief is sent (v2.3.5). "digest" (default): its `## Brief`
     * lines as the notification, the `## Also` list and a link to the full
     * report in the thread; line counts come from `ops/focus.md`. "full":
     * the whole report, as before.
     */
    format?: "digest" | "full";
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
   * Local interactive surfaces (`anima-mesh export-local`): which agents get
   * `.claude/agents/` + `.opencode/agents/` artifacts by default, and model
   * overrides for those artifacts. Absent ⇒ the hub agent, models mapped
   * from agent frontmatter.
   */
  localAgents?: {
    agents?: string[];
    /** `provider/model` for the opencode artifact (e.g. `kimi-code/k3`). */
    opencodeModel?: string;
    /** Claude Code artifact `model:` (alias or full id). Absent ⇒ inherit. */
    claudeModel?: string;
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
    /**
     * Channel-native sender ids (a Slack user id, an email address) who may
     * change `ops/focus.md` from a SHARED channel. Direct messages always
     * come from the principal; a group mention needs its sender listed here.
     */
    focusEditors?: string[];
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
