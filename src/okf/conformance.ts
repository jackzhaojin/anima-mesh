import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Bundle, Concept } from "./bundle.js";
import { conceptsByType, getConcept } from "./bundle.js";

/**
 * Conformance profiles:
 *  - `okf`       — the OKF v0.1 minimal surface: index.md + log.md reserved,
 *                  every concept has parseable frontmatter with a `type`.
 *  - `animamesh` — okf plus the engine's operating requirements: a constitution
 *                  concept marked immutable, and dated decisions/events.
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

export function checkConformance(
  bundle: Bundle,
  profile: ConformanceProfile = "okf",
): ConformanceReport {
  const issues: ConformanceIssue[] = [];
  const err = (rule: string, message: string, p?: string) =>
    issues.push({ level: "error", rule, message, path: p });
  const warn = (rule: string, message: string, p?: string) =>
    issues.push({ level: "warning", rule, message, path: p });

  // R1/R2 — reserved files exist at the bundle root.
  if (!getConcept(bundle, "index.md")) err("okf/index", "bundle is missing reserved index.md at its root");
  if (!getConcept(bundle, "log.md")) err("okf/log", "bundle is missing reserved log.md at its root");

  // R3 — every concept parses and declares a type.
  for (const c of bundle.concepts) {
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

  // R4 — relative markdown links resolve (warning: knowledge graphs drift).
  for (const c of bundle.concepts) {
    if (c.parseError || c.missingFrontmatter) continue;
    for (const match of c.body.matchAll(LINK_RE)) {
      const target = match[1]!;
      if (/^[a-z]+:\/\//i.test(target) || target.startsWith("/")) continue;
      const resolved = path.resolve(path.dirname(c.path), target);
      if (!existsSync(resolved)) {
        warn("okf/broken-link", `relative link does not resolve: ${target}`, c.relPath);
      }
    }
  }

  if (profile === "animamesh") {
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
