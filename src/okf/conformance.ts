import type { Bundle, Concept } from "./bundle-core.js";
import { conceptsByType, getConcept } from "./bundle-core.js";
import { checkSchemas } from "./schema.js";
import { checkFamilies, isReservedFile, OKF_VERSION } from "./trust.js";
import { checkLog } from "./log.js";

/**
 * Conformance profiles:
 *  - `okf`       - OKF v0.2 (SPEC §11): every non-reserved `.md` has parseable
 *                  frontmatter with a non-empty `type`. `index.md`/`log.md` are
 *                  reserved at any level and are NOT concepts; their §8/§9
 *                  structure, the provenance/trust/lifecycle families (§5),
 *                  and the declared `okf_version` are checked as warnings -
 *                  the spec makes them soft guidance a consumer must not
 *                  reject on.
 *  - `animamesh` - okf plus the engine's operating requirements: root
 *                  index.md + log.md present, a constitution concept marked
 *                  immutable, dated decisions/events, agent chokepoint fields.
 *
 * The same check validates a hand-built brain and the output of `init` —
 * the engine is tested by the same act that demos it.
 */
export type ConformanceProfile = "okf" | "animamesh";

export interface ConformanceIssue {
  level: "error" | "warning";
  rule: string;
  path?: string;
  message: string;
}

export interface ConformanceReport {
  ok: boolean;
  profile: ConformanceProfile;
  issues: ConformanceIssue[];
  conceptCount: number;
}

const LINK_RE = /\[[^\]]*\]\(([^)#?]+\.md)(?:[#?][^)]*)?\)/g;

/**
 * How R4 verifies a relative .md link. Default: pure bundle-membership —
 * resolve against the concept's relPath and require the target to be a
 * concept in this bundle (links escaping the bundle root are skipped: the
 * bundle cannot see outside itself remotely). Disk-backed callers may pass
 * an fs checker for full fidelity.
 */
export type LinkChecker = (concept: Concept, target: string) => boolean;

/** POSIX-only resolve of `target` against the directory of `relPath`; null if it escapes the root. */
function resolveRel(relPath: string, target: string): string | null {
  const baseParts = relPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (baseParts.length === 0) return null;
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join("/");
}

function membershipChecker(bundle: Bundle): LinkChecker {
  const relPaths = new Set(bundle.concepts.map((c) => c.relPath));
  return (concept, target) => {
    const resolved = resolveRel(concept.relPath, target);
    return resolved === null ? true : relPaths.has(resolved);
  };
}

export function checkConformance(
  bundle: Bundle,
  profile: ConformanceProfile = "okf",
  opts: { linkExists?: LinkChecker } = {},
): ConformanceReport {
  const linkExists = opts.linkExists ?? membershipChecker(bundle);
  const issues: ConformanceIssue[] = [];
  const err = (rule: string, message: string, p?: string) =>
    issues.push({ level: "error", rule, message, path: p });
  const warn = (rule: string, message: string, p?: string) =>
    issues.push({ level: "warning", rule, message, path: p });

  // R1/R2 - reserved files (SPEC §3.1, §8, §9): structure, not concepts.
  for (const c of bundle.concepts.filter((x) => isReservedFile(x.relPath))) {
    if (c.parseError) {
      err("okf/frontmatter-parse", `frontmatter failed to parse: ${c.parseError}`, c.relPath);
      continue;
    }
    if (c.relPath.endsWith("log.md")) {
      for (const i of checkLog(c.body, { hadFrontmatter: !c.missingFrontmatter })) warn(i.rule, i.message, c.relPath);
      continue;
    }
    const keys = Object.keys(c.frontmatter);
    const allowed = c.relPath === "index.md" ? ["okf_version"] : [];
    const extra = keys.filter((k) => !allowed.includes(k));
    if (extra.length > 0) {
      warn(
        "okf/index-frontmatter",
        `index files carry no frontmatter${c.relPath === "index.md" ? " except `okf_version`" : ""} (found: ${extra.join(", ")})`,
        c.relPath,
      );
    }
  }
  const rootIndex = getConcept(bundle, "index.md");
  if (rootIndex && !rootIndex.parseError) {
    const declared = rootIndex.frontmatter.okf_version;
    if (declared === undefined) {
      warn("okf/version", `bundle-root index.md does not declare \`okf_version: "${OKF_VERSION}"\``, "index.md");
    } else if (String(declared) !== OKF_VERSION) {
      warn("okf/version", `bundle declares okf_version ${JSON.stringify(declared)}; this engine reads OKF ${OKF_VERSION} (best-effort)`, "index.md");
    }
  }

  // R3 - every concept parses and declares a type.
  for (const c of bundle.concepts) {
    if (isReservedFile(c.relPath)) continue;
    if (c.parseError) {
      err("okf/frontmatter-parse", `frontmatter failed to parse: ${c.parseError}`, c.relPath);
      continue;
    }
    if (c.missingFrontmatter) {
      err("okf/frontmatter-missing", "concept has no YAML frontmatter block", c.relPath);
      continue;
    }
    if (typeof c.frontmatter.type !== "string" || c.frontmatter.type.trim() === "") {
      err("okf/type-required", "frontmatter must declare a non-empty `type`", c.relPath);
    }
  }

  // R4 - markdown links resolve (warning: knowledge graphs drift, and SPEC
  // §6.1 says a broken link is not-yet-written knowledge, never malformed).
  // Bundle-relative `/x.md` links (the form v0.2 recommends) resolve from
  // the bundle root.
  const relPaths = new Set(bundle.concepts.map((x) => x.relPath));
  for (const c of bundle.concepts) {
    if (c.parseError || (c.missingFrontmatter && !isReservedFile(c.relPath))) continue;
    for (const match of c.body.matchAll(LINK_RE)) {
      const target = match[1]!;
      if (/^[a-z]+:\/\//i.test(target)) continue;
      if (target.startsWith("/")) {
        if (!relPaths.has(target.slice(1))) warn("okf/broken-link", `bundle-relative link does not resolve: ${target}`, c.relPath);
        continue;
      }
      if (!linkExists(c, target)) {
        warn("okf/broken-link", `relative link does not resolve: ${target}`, c.relPath);
      }
    }
  }

  // R6 - the OKF v0.2 provenance / trust / lifecycle / computation families.
  for (const c of bundle.concepts) {
    if (isReservedFile(c.relPath) || c.parseError || c.missingFrontmatter) continue;
    for (const i of checkFamilies(c)) warn(i.rule, i.message, i.path);
  }

  // R5 - the ontology: concepts whose type declares a schema (a
  // `concept-type` concept) satisfy it. Opt-in per type; warnings unless
  // the schema says `strict: true`.
  issues.push(...checkSchemas(bundle));

  if (profile === "animamesh") {
    // A0 - the engine reads the root index and log every run (bundle context,
    // the agent card, brains sync): OKF makes them optional, AnimaMesh does not.
    if (!getConcept(bundle, "index.md")) err("okf/index", "bundle is missing reserved index.md at its root");
    if (!getConcept(bundle, "log.md")) err("okf/log", "bundle is missing reserved log.md at its root");

    // A1 — a constitution concept exists and is marked immutable.
    const constitutions = conceptsByType(bundle, "constitution");
    if (constitutions.length === 0) {
      err("animamesh/constitution", "no concept with type `constitution` found");
    } else {
      for (const c of constitutions) {
        if (c.frontmatter.immutable !== true) {
          err("animamesh/constitution-immutable", "constitution must set `immutable: true`", c.relPath);
        }
      }
    }

    // A2 — decisions and events are dated; decisions carry a status.
    for (const c of [...conceptsByType(bundle, "decision"), ...conceptsByType(bundle, "event")]) {
      if (!hasDate(c)) err("animamesh/dated", `${c.frontmatter.type} concepts must carry a date`, c.relPath);
    }

    // A3 — agent concepts declare the chokepoint fields (D14) and a valid level (D6).
    for (const c of conceptsByType(bundle, "agent")) {
      for (const field of ["model", "harness"] as const) {
        if (typeof c.frontmatter[field] !== "string" || (c.frontmatter[field] as string).trim() === "") {
          err("animamesh/agent-chokepoint", `agent concept must declare \`${field}\``, c.relPath);
        }
      }
      const level = c.frontmatter.level;
      if (level !== "L1" && level !== "L2" && level !== "L3" && level !== "L4") {
        err("animamesh/agent-level", "agent concept must declare level L1|L2|L3|L4", c.relPath);
      }
      // v2.2.0: OKF v0.2 reserves `sources:` for provenance; the read-source
      // opt-in is `context-sources:`. Legacy string entries still work.
      if (Array.isArray(c.frontmatter.sources) && c.frontmatter.sources.some((x) => typeof x === "string")) {
        warn(
          "animamesh/agent-context-sources",
          "read-source opt-ins moved to `context-sources:` (OKF v0.2 `sources:` is provenance) - `anima-mesh okf migrate` rewrites it",
          c.relPath,
        );
      }
    }

    // A5 - materialized ancestor constitutions (brains sync) are law the
    // gatekeeper reads: immutable, attributed, dated.
    for (const c of conceptsByType(bundle, "inherited-constitution")) {
      if (c.frontmatter.immutable !== true) {
        err("animamesh/inherited-immutable", "inherited-constitution must set `immutable: true`", c.relPath);
      }
      if (typeof c.frontmatter.from !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(c.frontmatter.from)) {
        err("animamesh/inherited-from", "inherited-constitution must name its source brain (`from: <brain-id>`)", c.relPath);
      }
      const synced = c.frontmatter.synced;
      if (!(synced instanceof Date) && !(typeof synced === "string" && /^\d{4}-\d{2}-\d{2}/.test(synced))) {
        err("animamesh/inherited-synced", "inherited-constitution must carry its `synced:` date", c.relPath);
      }
    }

    // A4 — the schedule surface, when present, is machine-readable: the due
    // decision consumes this file in code, so shape errors here are silent
    // scheduling bugs. Names are cross-checked against the roster (warning:
    // a renamed agent leaves a stale wake behind).
    const agentNames = new Set(
      conceptsByType(bundle, "agent").map((c) =>
        typeof c.frontmatter.name === "string" && c.frontmatter.name.trim()
          ? c.frontmatter.name
          : c.relPath.replace(/^.*\//, "").replace(/\.md$/, ""),
      ),
    );
    const scheduleCadences = new Set(["daily", "weekly", "monthly", "quarterly"]);
    for (const c of conceptsByType(bundle, "schedule")) {
      for (const field of ["wake", "pause"] as const) {
        const value = c.frontmatter[field];
        if (value === undefined) continue;
        if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
          err("animamesh/schedule-shape", `\`${field}\` must be an array of agent names`, c.relPath);
          continue;
        }
        for (const name of value) {
          if (!agentNames.has(name)) warn("animamesh/schedule-unknown-agent", `\`${field}\` names unknown agent '${name}'`, c.relPath);
        }
      }
      const cadence = c.frontmatter.cadence;
      if (cadence !== undefined) {
        if (typeof cadence !== "object" || cadence === null || Array.isArray(cadence)) {
          err("animamesh/schedule-shape", "`cadence` must be a map of agent name → cadence", c.relPath);
        } else {
          for (const [name, value] of Object.entries(cadence as Record<string, unknown>)) {
            if (typeof value !== "string" || !scheduleCadences.has(value)) {
              err(
                "animamesh/schedule-cadence",
                `cadence for '${name}' must be one of ${[...scheduleCadences].join("|")}, got ${JSON.stringify(value)}`,
                c.relPath,
              );
            }
            if (!agentNames.has(name)) warn("animamesh/schedule-unknown-agent", `\`cadence\` names unknown agent '${name}'`, c.relPath);
          }
        }
      }
    }
  }

  return {
    ok: !issues.some((i) => i.level === "error"),
    profile,
    issues,
    conceptCount: bundle.concepts.length,
  };
}

function hasDate(c: Concept): boolean {
  const d = c.frontmatter.date;
  if (d instanceof Date) return true;
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d)) return true;
  return false;
}

export function formatReport(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(
    `${report.ok ? "PASS" : "FAIL"} — profile=${report.profile}, ${report.conceptCount} concept(s), ` +
      `${report.issues.filter((i) => i.level === "error").length} error(s), ` +
      `${report.issues.filter((i) => i.level === "warning").length} warning(s)`,
  );
  for (const issue of report.issues) {
    lines.push(`  [${issue.level}] ${issue.rule}${issue.path ? ` @ ${issue.path}` : ""} — ${issue.message}`);
  }
  return lines.join("\n");
}
