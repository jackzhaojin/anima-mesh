import type { Bundle, Concept } from "./bundle-core.js";
import type { Frontmatter } from "./frontmatter.js";

/**
 * OKF v0.2 - provenance, trust, and lifecycle (SPEC §5, §7, §10).
 *
 * v0.2 makes "where did this come from, how much should I trust it, is it
 * still current" answerable from frontmatter, for a corpus that agents keep
 * writing. This module is the CONSUMER side of those families: pure and
 * Workers-safe, so the harness, the CLI, and conformance all derive the same
 * answers from the same fields.
 *
 * ```yaml
 * generated: { by: claude-code/claude-opus-5-5, at: 2026-10-11T14:00:00-04:00 }
 * verified:  { by: human:ada, at: 2026-10-11T15:00:00-04:00 }   # or a list
 * status: stable                     # draft | stable | deprecated (absent = stable)
 * stale_after: 2027-04-15T00:00:00Z  # absolute instant
 * sources:
 *   - { id: ein-letter, resource: "Legal/irs-ein/CP575.pdf", title: IRS CP575 notice }
 * ```
 *
 * Everything here is advisory signal, never access control (SPEC §5.3):
 * the gatekeeper does not read trust tiers, and nothing is rejected for
 * missing a family (SPEC §11).
 */

export const OKF_VERSION = "0.2";

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";
export type Lifecycle = "draft" | "stable" | "deprecated";
export const LIFECYCLE_VALUES: readonly Lifecycle[] = ["draft", "stable", "deprecated"];

/** The keys v0.2 gives meaning to. A domain must not reuse them for something else. */
export const OKF_RESERVED_KEYS = [
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "sources",
  "usage_window",
  "generated",
  "verified",
  "status",
  "stale_after",
] as const;

export interface Actor {
  kind: "human" | "process" | "agent";
  /** The id after the prefix (human/process) or the whole `<producer>/<version>` string (agent). */
  id: string;
  raw: string;
}

/** SPEC §7: `human:<id>`, `process:<id>`, or `<producer>/<version>`. Null when it fits none. */
export function parseActor(raw: unknown): Actor | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const prefixed = /^(human|process):([^\s:][^\s]*)$/.exec(s);
  if (prefixed) return { kind: prefixed[1] as "human" | "process", id: prefixed[2]!, raw: s };
  if (/^[^\s/:]+\/[^\s]+$/.test(s)) return { kind: "agent", id: s, raw: s };
  return null;
}

/**
 * SPEC §5: every timestamp is an ISO 8601 datetime with an explicit UTC
 * offset. A YAML timestamp the parser already turned into a Date counts.
 */
export function isOkfDateTime(v: unknown): boolean {
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  if (typeof v !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v.trim())) return false;
  return !Number.isNaN(Date.parse(v));
}

export function toInstant(v: unknown): number | null {
  if (!isOkfDateTime(v)) return null;
  return v instanceof Date ? v.getTime() : Date.parse(v as string);
}

export interface Verification {
  by: string;
  at?: unknown;
}

/** SPEC §5.2: a bare `{ by, at }` mapping is a one-element list. */
export function verifications(fm: Frontmatter): Verification[] {
  const v = fm.verified;
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.filter(
    (x): x is Verification => typeof x === "object" && x !== null && typeof (x as Verification).by === "string",
  );
}

/** SPEC §5.3: derived, never stored. */
export function trustTier(fm: Frontmatter): TrustTier {
  const list = verifications(fm);
  if (list.length === 0) return "unverified";
  return list.some((v) => parseActor(v.by)?.kind === "human") ? "human-reviewed" : "machine-confirmed";
}

/** The latest verification instant, or null. "How recently" is the latest `at` (SPEC §5.2). */
export function lastVerifiedAt(fm: Frontmatter): number | null {
  let best: number | null = null;
  for (const v of verifications(fm)) {
    const t = toInstant(v.at);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

/** SPEC §5.4: absent ⇒ stable. A non-lifecycle value is reported by conformance, read here as stable. */
export function lifecycle(fm: Frontmatter): Lifecycle {
  return LIFECYCLE_VALUES.includes(fm.status as Lifecycle) ? (fm.status as Lifecycle) : "stable";
}

/** SPEC §5.5: stale when now >= stale_after. */
export function isStale(fm: Frontmatter, now: Date = new Date()): boolean {
  const t = toInstant(fm.stale_after);
  return t !== null && now.getTime() >= t;
}

export interface SourceEntry {
  resource: string;
  id?: string;
  title?: string;
  author?: string;
  usage_count?: number;
  last_modified?: unknown;
}

/** SPEC §5.1: the well-formed provenance entries (objects carrying `resource`). */
export function provenance(fm: Frontmatter): SourceEntry[] {
  if (!Array.isArray(fm.sources)) return [];
  return fm.sources.filter(
    (s): s is SourceEntry =>
      typeof s === "object" && s !== null && typeof (s as SourceEntry).resource === "string",
  );
}

/** When the content last meaningfully changed: `generated.at`, else the v0.1 `timestamp` (SPEC §13.1). */
export function generatedAt(fm: Frontmatter): number | null {
  const g = fm.generated;
  if (typeof g === "object" && g !== null && !Array.isArray(g)) {
    const t = toInstant((g as Record<string, unknown>).at);
    if (t !== null) return t;
  }
  return toInstant(fm.timestamp);
}

export interface FamilyIssue {
  level: "warning";
  rule: string;
  path: string;
  message: string;
}

const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\](?!:)/g;

/**
 * The v0.2 family shapes, checked as warnings. SPEC §11 makes every family
 * soft guidance: a consumer MUST NOT reject a concept for them, so neither
 * does conformance. A wrong shape is still worth saying out loud, because a
 * malformed `verified` silently reads as "unverified" everywhere downstream.
 */
export function checkFamilies(c: Concept): FamilyIssue[] {
  const fm = c.frontmatter;
  const out: FamilyIssue[] = [];
  const warn = (rule: string, message: string) => out.push({ level: "warning", rule, path: c.relPath, message });

  if (fm.status !== undefined && !LIFECYCLE_VALUES.includes(fm.status as Lifecycle)) {
    warn(
      "okf/status",
      `\`status\` is the OKF v0.2 lifecycle (draft | stable | deprecated), got ${JSON.stringify(fm.status)} - ` +
        "move trust into `verified:` and domain workflow state into its own key (e.g. `stage:`)",
    );
  }

  if (fm.generated !== undefined) {
    const g = fm.generated;
    if (typeof g !== "object" || g === null || Array.isArray(g)) {
      warn("okf/generated", "`generated` must be a `{ by, at }` mapping");
    } else {
      const gm = g as Record<string, unknown>;
      if (!parseActor(gm.by)) warn("okf/actor", `\`generated.by\` must be an actor (human:<id> | process:<id> | <producer>/<version>), got ${JSON.stringify(gm.by)}`);
      if (gm.at !== undefined && !isOkfDateTime(gm.at)) warn("okf/datetime", `\`generated.at\` must be an ISO 8601 datetime with an offset, got ${JSON.stringify(gm.at)}`);
    }
  }

  if (fm.verified !== undefined) {
    const raw = Array.isArray(fm.verified) ? fm.verified : [fm.verified];
    for (const v of raw) {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        warn("okf/verified", "each `verified` entry must be a `{ by, at }` mapping");
        continue;
      }
      const vm = v as Record<string, unknown>;
      if (!parseActor(vm.by)) warn("okf/actor", `\`verified[].by\` must be an actor (human:<id> | process:<id> | <producer>/<version>), got ${JSON.stringify(vm.by)}`);
      if (!isOkfDateTime(vm.at)) warn("okf/datetime", `\`verified[].at\` must be an ISO 8601 datetime with an offset, got ${JSON.stringify(vm.at)}`);
    }
  }

  if (fm.stale_after !== undefined && !isOkfDateTime(fm.stale_after)) {
    warn("okf/datetime", `\`stale_after\` must be an ISO 8601 datetime with an offset, got ${JSON.stringify(fm.stale_after)}`);
  }

  const ids = new Set<string>();
  if (fm.sources !== undefined) {
    if (!Array.isArray(fm.sources)) {
      warn("okf/sources", "`sources` must be a list of `{ resource, id?, title? }` entries");
    } else {
      for (const s of fm.sources) {
        if (typeof s !== "object" || s === null || typeof (s as SourceEntry).resource !== "string") {
          warn("okf/sources", `each \`sources\` entry needs a \`resource\` (a URL, a bundle path, or a scope descriptor), got ${JSON.stringify(s)}`);
          continue;
        }
        const e = s as SourceEntry;
        if (typeof e.id === "string") ids.add(e.id);
        if (e.author !== undefined && !parseActor(e.author) && !/^team:/.test(String(e.author))) {
          warn("okf/actor", `\`sources[].author\` should be an actor, got ${JSON.stringify(e.author)}`);
        }
        if (e.last_modified !== undefined && !isOkfDateTime(e.last_modified)) {
          warn("okf/datetime", `\`sources[].last_modified\` must be an ISO 8601 datetime with an offset`);
        }
      }
    }
  }
  for (const m of c.body.matchAll(FOOTNOTE_REF_RE)) {
    const label = m[1]!;
    // Footnote labels are the join key into `sources` (SPEC §5.1); a label
    // with no matching id is a citation that attributes nothing.
    if (ids.size > 0 && !ids.has(label)) {
      warn("okf/footnote-source", `footnote [^${label}] matches no \`sources[].id\``);
    }
  }

  if (fm.timestamp !== undefined) {
    warn("okf/legacy-timestamp", "`timestamp` is OKF v0.1; v0.2 records the last content change as `generated: { by, at }`");
  }
  if (/^#{1,6}\s+Citations\s*$/m.test(c.body)) {
    warn("okf/legacy-citations", "a body `# Citations` list is OKF v0.1; v0.2 records provenance in frontmatter `sources`");
  }

  if (fm.type === "Attested Computation") {
    if (typeof fm.runtime !== "string" || !fm.runtime.trim()) {
      warn("okf/computation-runtime", "an Attested Computation must declare `runtime` (SPEC §10.2)");
    }
    const hasFence = /^#{1,6}\s+Computation\s*$/m.test(c.body);
    if (!hasFence && typeof fm.computation !== "string") {
      warn("okf/computation-body", "an Attested Computation needs a `# Computation` body block or a `computation:` path (SPEC §10.3)");
    }
  }
  return out;
}

export interface TrustDigest {
  tiers: Record<TrustTier, number>;
  lifecycle: Record<Lifecycle, number>;
  stale: Concept[];
  drafts: Concept[];
  deprecated: Concept[];
  /** Concepts that declare no provenance at all (no `sources`, no `generated`). */
  unattributed: Concept[];
  total: number;
}

/** Roll the families up across a bundle - for the CLI view and the harness's ambient context. */
export function trustDigest(bundle: Bundle, now: Date = new Date()): TrustDigest {
  const d: TrustDigest = {
    tiers: { unverified: 0, "machine-confirmed": 0, "human-reviewed": 0 },
    lifecycle: { draft: 0, stable: 0, deprecated: 0 },
    stale: [],
    drafts: [],
    deprecated: [],
    unattributed: [],
    total: 0,
  };
  for (const c of bundle.concepts) {
    if (isReservedFile(c.relPath) || c.missingFrontmatter || c.parseError) continue;
    d.total++;
    d.tiers[trustTier(c.frontmatter)]++;
    const life = lifecycle(c.frontmatter);
    d.lifecycle[life]++;
    if (life === "draft") d.drafts.push(c);
    if (life === "deprecated") d.deprecated.push(c);
    if (isStale(c.frontmatter, now)) d.stale.push(c);
    if (provenance(c.frontmatter).length === 0 && c.frontmatter.generated === undefined) d.unattributed.push(c);
  }
  return d;
}

/** SPEC §3.1: `index.md` and `log.md` are reserved at ANY level of the hierarchy. */
export function isReservedFile(relPath: string): boolean {
  const name = relPath.replace(/^.*\//, "");
  return name === "index.md" || name === "log.md";
}
