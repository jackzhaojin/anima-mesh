import type { Bundle, Concept } from "../okf/bundle-core.js";
import { conceptsByType } from "../okf/bundle-core.js";
import type { InstanceStore } from "../instance/store.js";
import type {
  BrainIdentity,
  BrainKind,
  BrainLinkConfig,
  BrainRelation,
  InstanceConfig,
  MemberConfig,
  MemberRole,
} from "../instance/config-core.js";
import { newestReportName } from "../harness/latest-report.js";

/**
 * The mesh of brains (v0.18.0) - layering and multi-player, Workers-safe.
 *
 * A brain is one instance repo: a person's life, an org, a team inside an
 * org, or a shared group. Brains connect through typed LINKS declared on
 * both sides (mutual consent), and knowledge crosses a link only when the
 * concept that holds it carries a `share:` marking that admits the reader.
 * Deny by default: an unmarked concept never leaves its brain.
 *
 * Two kinds of marking, the way an ontology's permission model has two:
 *  - `share:` GRANTS (discretionary): which linked brains may see a concept.
 *  - `markings:` RESTRICT (mandatory, conjunctive): a concept marked
 *    `[finance]` crosses only links whose grants clear `finance`, whatever
 *    its `share:` says. A sloppy share can never leak a marked concept.
 *
 * Three rules this module enforces in code, never in prompts:
 *  1. A link is live only when both brains declare it with inverse
 *     relations; the exporter's own config decides what the reader is.
 *  2. The EXPORTER's markings decide what leaves - the reader cannot widen
 *     them, and a linked brain is opened read-only.
 *  3. Containment inherits law: a child brain's gates are the union of its
 *     own constitution and every materialized ancestor constitution.
 */

export const BRAIN_KINDS: readonly BrainKind[] = ["person", "org", "team", "group"];
export const BRAIN_RELATIONS: readonly BrainRelation[] = ["member-of", "has-member", "child-of", "parent-of", "peer-of"];
export const MEMBER_ROLES: readonly MemberRole[] = ["owner", "approver", "contributor", "viewer"];
/** Roles that may decide an approval. */
export const DECIDING_ROLES: ReadonlySet<MemberRole> = new Set(["owner", "approver"]);

export const INVERSE_RELATION: Readonly<Record<BrainRelation, BrainRelation>> = {
  "member-of": "has-member",
  "has-member": "member-of",
  "child-of": "parent-of",
  "parent-of": "child-of",
  "peer-of": "peer-of",
};

/**
 * `share:` audience tokens, keyed by the EXPORTER's relation to the reader:
 * a brain that `has-member` the reader shares `members`-marked concepts
 * with it, and so on. `linked` admits every live link; a brain id admits
 * exactly that brain.
 */
export const AUDIENCE_FOR_RELATION: Readonly<Record<BrainRelation, string>> = {
  "has-member": "members",
  "member-of": "groups",
  "child-of": "parent",
  "parent-of": "children",
  "peer-of": "peers",
};

export const LINKED_AUDIENCE = "linked";

/** Words with fixed meaning in `share:` and configs - no brain may take one as its id. */
export const RESERVED_TOKENS: ReadonlySet<string> = new Set([
  ...BRAIN_RELATIONS,
  ...Object.values(AUDIENCE_FOR_RELATION),
  LINKED_AUDIENCE,
]);

/** The concept type a materialized ancestor constitution carries (see brains sync). */
export const INHERITED_CONSTITUTION_TYPE = "inherited-constitution";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REPO_RE = /^[^/\s]+\/[^/\s#]+$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_RE.test(value);
}

/**
 * Everything wrong with a config's brain/links/members blocks; [] = valid.
 * Pure. Callers that READ across links refuse to when this is non-empty -
 * a malformed link map fails closed, never half-open.
 */
export function brainConfigProblems(config: InstanceConfig): string[] {
  const problems: string[] = [];
  const brain = config.brain;
  if (brain !== undefined) {
    if (typeof brain !== "object" || brain === null) {
      problems.push("brain must be an object { id, kind, name? }");
    } else {
      if (!isSlug(brain.id)) problems.push(`brain.id ${JSON.stringify(brain.id)} must be a lowercase slug (a-z, 0-9, hyphens)`);
      else if (RESERVED_TOKENS.has(brain.id)) problems.push(`brain.id '${brain.id}' is a reserved word`);
      if (!BRAIN_KINDS.includes(brain.kind)) problems.push(`brain.kind must be one of ${BRAIN_KINDS.join("|")}, got ${JSON.stringify(brain.kind)}`);
    }
  }

  const links = config.links;
  if (links !== undefined) {
    if (!Array.isArray(links)) {
      problems.push("links must be an array");
    } else {
      if (links.length > 0 && !brain) problems.push("links require a brain identity - declare brain.id before linking");
      const seen = new Set<string>();
      let parents = 0;
      for (const [i, link] of links.entries()) {
        const at = `links[${i}]`;
        if (typeof link !== "object" || link === null) {
          problems.push(`${at} must be an object`);
          continue;
        }
        if (!isSlug(link.id)) problems.push(`${at}.id ${JSON.stringify(link.id)} must be a lowercase slug`);
        else if (RESERVED_TOKENS.has(link.id)) problems.push(`${at}.id '${link.id}' is a reserved word`);
        else if (brain && link.id === brain.id) problems.push(`${at}: a brain cannot link to itself`);
        else if (seen.has(link.id)) problems.push(`${at}: duplicate link to '${link.id}'`);
        if (typeof link.id === "string") seen.add(link.id);
        if (!BRAIN_RELATIONS.includes(link.relation)) {
          problems.push(`${at}.relation must be one of ${BRAIN_RELATIONS.join("|")}, got ${JSON.stringify(link.relation)}`);
        }
        if (link.relation === "child-of") parents++;
        if (link.localPath !== undefined && (typeof link.localPath !== "string" || !link.localPath.trim())) {
          problems.push(`${at}.localPath must be a non-empty string`);
        }
        if (link.repo !== undefined && (typeof link.repo !== "string" || !REPO_RE.test(link.repo))) {
          problems.push(`${at}.repo must be "owner/name", got ${JSON.stringify(link.repo)}`);
        }
        if (link.ref !== undefined && (typeof link.ref !== "string" || !link.ref.trim())) {
          problems.push(`${at}.ref must be a non-empty string`);
        }
        if (link.tokenEnv !== undefined && (typeof link.tokenEnv !== "string" || !ENV_NAME_RE.test(link.tokenEnv))) {
          problems.push(`${at}.tokenEnv must be an ENV_VAR_NAME`);
        }
        if (link.grants !== undefined) {
          if (typeof link.grants !== "object" || link.grants === null || Array.isArray(link.grants)) {
            problems.push(`${at}.grants must be an object`);
          } else {
            for (const [key, value] of Object.entries(link.grants)) {
              if (key === "brief") {
                if (typeof value !== "boolean") problems.push(`${at}.grants.brief must be true|false`);
              } else if (key === "markings") {
                if (!Array.isArray(value) || !value.every((m) => isSlug(m))) {
                  problems.push(`${at}.grants.markings must be a list of marking slugs`);
                }
              } else {
                problems.push(`${at}.grants.${key} is not a known grant (known: brief, markings)`);
              }
            }
          }
        }
      }
      if (parents > 1) problems.push("at most one child-of link - a brain sits in exactly one containment chain");
    }
  }

  const members = config.identity?.members;
  if (members !== undefined) {
    if (!Array.isArray(members) || members.length === 0) {
      problems.push("identity.members, when present, must be a non-empty array");
    } else {
      const ids = new Set<string>();
      let owners = 0;
      for (const [i, m] of members.entries()) {
        const at = `identity.members[${i}]`;
        if (typeof m !== "object" || m === null) {
          problems.push(`${at} must be an object`);
          continue;
        }
        if (!isSlug(m.id)) problems.push(`${at}.id ${JSON.stringify(m.id)} must be a lowercase slug`);
        else if (ids.has(m.id)) problems.push(`${at}: duplicate member id '${m.id}'`);
        if (typeof m.id === "string") ids.add(m.id);
        if (typeof m.name !== "string" || !m.name.trim()) problems.push(`${at}.name is required`);
        if (!MEMBER_ROLES.includes(m.role)) problems.push(`${at}.role must be one of ${MEMBER_ROLES.join("|")}, got ${JSON.stringify(m.role)}`);
        if (m.role === "owner") owners++;
        if (m.email !== undefined && (typeof m.email !== "string" || !m.email.includes("@"))) {
          problems.push(`${at}.email must be an email address`);
        }
        if (m.brain !== undefined && !isSlug(m.brain)) problems.push(`${at}.brain must be a brain id`);
      }
      if (owners === 0) problems.push("identity.members needs at least one owner");
    }
  }
  return problems;
}

// ---- members (multi-player) ---------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/**
 * The humans who act in this brain. Declared `identity.members` win;
 * otherwise the single-player default - the principal alone, as owner.
 */
export function effectiveMembers(config: InstanceConfig): MemberConfig[] {
  const declared = config.identity?.members;
  if (Array.isArray(declared) && declared.length > 0) return declared;
  const principal = config.identity?.principal;
  if (!principal?.name) return [];
  return [
    {
      id: slugify(principal.name) || "principal",
      name: principal.name,
      ...(principal.email ? { email: principal.email } : {}),
      role: "owner",
    },
  ];
}

/** A member by id or email (case-insensitive). */
export function findMember(config: InstanceConfig, handle: string): MemberConfig | undefined {
  const h = handle.trim().toLowerCase();
  return effectiveMembers(config).find((m) => m.id === h || (m.email ?? "").toLowerCase() === h);
}

/**
 * Who may decide an approval. A brain that declares members gets the check
 * in code: the decider must be a member whose role is owner or approver.
 * A single-player brain (no members block) keeps the historical behavior -
 * the CLI caller IS the principal. Returns the member when one was matched.
 */
export function assertMayDecide(config: InstanceConfig, handle: string): MemberConfig | undefined {
  const declared = config.identity?.members;
  if (!Array.isArray(declared) || declared.length === 0) return undefined;
  const member = findMember(config, handle);
  if (!member) {
    throw new Error(`'${handle}' is not a member of this brain - approvals are decided by a member (owner|approver); members: ${declared.map((m) => m.id).join(", ")}`);
  }
  if (!DECIDING_ROLES.has(member.role)) {
    throw new Error(`member '${member.id}' is a ${member.role} - only owner or approver members may decide approvals`);
  }
  return member;
}

// ---- share markings -----------------------------------------------------------

/** A concept's `share:` marking, normalized. [] means private - the default. */
export function shareTokens(concept: Concept): string[] {
  const raw = concept.frontmatter.share;
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  }
  return [];
}

/**
 * Does a marking admit this reader? `relation` is the EXPORTER's declared
 * relation to the reader - the exporter's config is the only authority on
 * what the reader is. Deny by default.
 */
export function shareAdmits(tokens: readonly string[], reader: { id: string; relation: BrainRelation }): boolean {
  const audience = AUDIENCE_FOR_RELATION[reader.relation];
  return tokens.some((t) => t === reader.id || t === audience || t === LINKED_AUDIENCE);
}

/** A concept's mandatory `markings:`, normalized. [] = unrestricted. */
export function markingsOf(concept: Concept): string[] {
  const raw = concept.frontmatter.markings;
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  }
  return [];
}

/** Conjunctive: every marking on the concept must be cleared by the link. */
export function markingsCleared(markings: readonly string[], cleared: readonly string[] | undefined): boolean {
  return markings.every((m) => (cleared ?? []).includes(m));
}

/** Tokens a bundle's markings may use given its config: link ids + audience words. */
export function knownShareTokens(config: InstanceConfig): Set<string> {
  const known = new Set<string>([LINKED_AUDIENCE, ...Object.values(AUDIENCE_FOR_RELATION)]);
  for (const link of config.links ?? []) if (typeof link?.id === "string") known.add(link.id);
  return known;
}

export interface BrainIssue {
  level: "error" | "warning";
  rule: string;
  path?: string;
  message: string;
}

/**
 * Config-aware checks the bundle-only conformance pass cannot make: the
 * link map's shape (errors - a malformed map is refused at read time) and
 * markings that name nobody this brain links to (warnings - such a marking
 * fails closed, but the author meant something by it).
 */
export function brainIssues(bundle: Bundle, config: InstanceConfig): BrainIssue[] {
  const issues: BrainIssue[] = brainConfigProblems(config).map((message) => ({
    level: "error" as const,
    rule: "brains/config",
    message,
  }));
  const known = knownShareTokens(config);
  for (const concept of bundle.concepts) {
    if (concept.parseError || concept.missingFrontmatter) continue;
    const raw = concept.frontmatter.share;
    if (raw !== undefined && typeof raw !== "string" && !Array.isArray(raw)) {
      issues.push({ level: "error", rule: "brains/share-shape", path: concept.relPath, message: "`share` must be a token or a list of tokens" });
      continue;
    }
    const rawMarkings = concept.frontmatter.markings;
    if (rawMarkings !== undefined && typeof rawMarkings !== "string" && !Array.isArray(rawMarkings)) {
      issues.push({ level: "error", rule: "brains/markings-shape", path: concept.relPath, message: "`markings` must be a marking or a list of markings" });
    }
    const tokens = shareTokens(concept);
    const marks = markingsOf(concept);
    if (tokens.length > 0 && marks.length > 0) {
      const audience = new Set(tokens);
      const blocked = (config.links ?? []).filter(
        (l) =>
          (audience.has(l.id) || audience.has(AUDIENCE_FOR_RELATION[l.relation]) || audience.has(LINKED_AUDIENCE)) &&
          !markingsCleared(marks, l.grants?.markings),
      );
      for (const l of blocked) {
        issues.push({
          level: "warning",
          rule: "brains/marking-blocks-share",
          path: concept.relPath,
          message: `shared with '${l.id}' but marked [${marks.join(", ")}], which that link does not clear - it will NOT cross (mandatory markings win)`,
        });
      }
    }
    if (tokens.length > 0 && !config.brain) {
      issues.push({
        level: "warning",
        rule: "brains/share-no-identity",
        path: concept.relPath,
        message: "concept carries `share:` but this brain declares no identity - nothing can read it",
      });
    }
    for (const token of tokens) {
      if (!known.has(token)) {
        issues.push({
          level: "warning",
          rule: "brains/share-unknown",
          path: concept.relPath,
          message: `share token '${token}' matches no link or audience (known: ${[...known].sort().join(", ")}) - it admits nobody`,
        });
      }
    }
  }
  // A brief is derived from EVERYTHING its hub read - inbox, finances,
  // marked concepts. A person brain granting it across a link exports its
  // whole life in prose; say so loudly.
  if (config.brain?.kind === "person") {
    for (const l of config.links ?? []) {
      if (l.grants?.brief === true) {
        issues.push({
          level: "warning",
          rule: "brains/person-brief-granted",
          message: `this person brain grants its brief to '${l.id}' - a brief carries everything the hub read (inbox, finances, family); share specific concepts instead`,
        });
      }
    }
  }
  // A member's own person brain is linked via has-member - unless the member
  // IS this brain's person (a person brain listing its own principal).
  const memberBrains = (config.identity?.members ?? []).filter(
    (m) => typeof m?.brain === "string" && m.brain !== config.brain?.id,
  );
  for (const m of memberBrains) {
    const linked = (config.links ?? []).some((l) => l.id === m.brain && l.relation === "has-member");
    if (!linked) {
      issues.push({
        level: "warning",
        rule: "brains/member-unlinked",
        message: `member '${m.id}' names brain '${m.brain}' but no has-member link to it is declared`,
      });
    }
  }
  return issues;
}

// ---- read-only access -----------------------------------------------------------

/**
 * A linked brain is opened read-only - as a code property, not a
 * convention: every write path on the facade throws, so no caller (and no
 * future refactor) can append to another brain's ledger or commit to it.
 */
export function readOnlyStore(inner: InstanceStore): InstanceStore {
  const refuse = (what: string): never => {
    throw new Error(`linked brains are read-only: ${what} refused`);
  };
  return {
    root: inner.root,
    bundleDir: inner.bundleDir,
    loadConfig: () => inner.loadConfig(),
    loadBundle: () => inner.loadBundle(),
    readOptional: (rel) => inner.readOptional(rel),
    listFiles: (rel) => inner.listFiles(rel),
    listReports: () => inner.listReports(),
    readReport: (name) => inner.readReport(name),
    writeReport: async () => refuse("writeReport"),
    reportPath: (name) => inner.reportPath(name),
    readLedger: () => inner.readLedger(),
    appendLedger: async () => refuse("appendLedger"),
    listApprovals: (status) => inner.listApprovals(status),
    getApproval: (id) => inner.getApproval(id),
    writeFile: async () => refuse("writeFile"),
    flush: async () => refuse("flush"),
  };
}

// ---- the export view -----------------------------------------------------------

export interface ExportedConcept {
  /** Bundle-relative path in the exporting brain. */
  relPath: string;
  type: string;
  /** The raw file (frontmatter + body). */
  content: string;
}

export interface BrainExport {
  brain: BrainIdentity;
  /** The exporter's declared relation to the reader. */
  relation: BrainRelation;
  role?: string;
  /** Concepts whose markings admit the reader, sorted by path. */
  concepts: ExportedConcept[];
  /** Admitted concepts left out by the size cap. */
  omitted: number;
  /** Size of the exporter's bundle - the reader learns how much it cannot see, never what. */
  totalConcepts: number;
  /** The hub's latest brief, when the exporter grants `brief` on this link. */
  brief?: { name: string; content: string };
  /**
   * Law flowing down a containment link: present only when the reader is the
   * exporter's child - the exporter's constitution plus every constitution
   * it inherited itself (a chain flattens on the way down).
   */
  constitutions?: Array<{ from: string; content: string; gatedActions: string[] }>;
}

export type ExportResult = { ok: true; view: BrainExport } | { ok: false; reason: string };

export const MAX_EXPORT_CONCEPTS = 60;

function gatedActionsOf(concept: Concept | undefined): string[] {
  const declared = concept?.frontmatter["gated-actions"];
  return Array.isArray(declared) ? declared.filter((x): x is string => typeof x === "string") : [];
}

/**
 * What `store`'s brain gives the brain `readerId` - computed from the
 * EXPORTER's config and markings only. Deterministic and side-effect free;
 * the same function backs the laptop read, the GitHub read, and the CLI's
 * "who can see what" view.
 */
export async function computeExport(
  store: InstanceStore,
  readerId: string,
  opts: { maxConcepts?: number } = {},
): Promise<ExportResult> {
  const config = await store.loadConfig();
  const problems = brainConfigProblems(config);
  if (problems.length > 0) {
    return { ok: false, reason: `that brain's link config is invalid (${problems[0]}) - it exports nothing until fixed` };
  }
  if (!config.brain) return { ok: false, reason: "that brain declares no identity (brain.id) - it exports nothing" };
  const link = (config.links ?? []).find((l) => l.id === readerId);
  if (!link) {
    return {
      ok: false,
      reason: `'${config.brain.id}' declares no link to '${readerId}' - a link is live only when both brains declare it`,
    };
  }
  const bundle = await store.loadBundle();
  const reader = { id: readerId, relation: link.relation };
  const admitted = bundle.concepts
    .filter(
      (c) =>
        !c.parseError &&
        !c.missingFrontmatter &&
        shareAdmits(shareTokens(c), reader) &&
        // Mandatory markings: conjunctive, and they win over any grant.
        markingsCleared(markingsOf(c), link.grants?.markings),
    )
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  const cap = opts.maxConcepts ?? MAX_EXPORT_CONCEPTS;
  const concepts: ExportedConcept[] = [];
  for (const c of admitted.slice(0, cap)) {
    const raw = await store.readOptional(`${config.bundle}/${c.relPath}`);
    if (raw === null) continue;
    concepts.push({ relPath: c.relPath, type: String(c.frontmatter.type ?? ""), content: raw });
  }

  const view: BrainExport = {
    brain: config.brain,
    relation: link.relation,
    ...(link.role ? { role: link.role } : {}),
    concepts,
    omitted: Math.max(0, admitted.length - cap),
    totalConcepts: bundle.concepts.length,
  };

  if (link.grants?.brief === true) {
    const hub = config.delivery?.deliverAgent ?? "chief-of-staff";
    const name = await newestReportName(store, hub);
    if (name) view.brief = { name, content: await store.readReport(name) };
  }

  if (link.relation === "parent-of") {
    const own = conceptsByType(bundle, "constitution")[0];
    const constitutions: NonNullable<BrainExport["constitutions"]> = [];
    if (own) {
      const raw = await store.readOptional(`${config.bundle}/${own.relPath}`);
      if (raw !== null) constitutions.push({ from: config.brain.id, content: raw, gatedActions: gatedActionsOf(own) });
    }
    for (const inherited of conceptsByType(bundle, INHERITED_CONSTITUTION_TYPE)) {
      const raw = await store.readOptional(`${config.bundle}/${inherited.relPath}`);
      const from = inherited.frontmatter.from;
      if (raw !== null && typeof from === "string") {
        constitutions.push({ from, content: raw, gatedActions: gatedActionsOf(inherited) });
      }
    }
    view.constitutions = constitutions;
  }
  return { ok: true, view };
}

/** Gated action types every materialized ancestor constitution adds (see gatekeeper.loadGatedTypes). */
export function inheritedGatedTypes(bundle: Bundle): string[] {
  const out = new Set<string>();
  for (const c of conceptsByType(bundle, INHERITED_CONSTITUTION_TYPE)) {
    for (const t of gatedActionsOf(c)) out.add(t);
  }
  return [...out];
}

/** The id of this brain's parent, when it declares a containment link. */
export function parentLink(config: InstanceConfig): BrainLinkConfig | undefined {
  return (config.links ?? []).find((l) => l.relation === "child-of");
}
