import { parseConcept } from "./frontmatter.js";
import { convertLegacyLog } from "./log.js";
import { LIFECYCLE_VALUES, OKF_VERSION } from "./trust.js";

/**
 * OKF v0.1 → v0.2, the MECHANICAL half (v2.2.0). Pure: (relPath, raw) in,
 * new raw out. Only rewrites what has exactly one correct answer, and edits
 * frontmatter line-by-line so YAML comments and key order survive:
 *
 *  - index files lose their frontmatter; the bundle-root one declares
 *    `okf_version` (a legacy `title:` becomes the H1 when the body has none)
 *  - log files lose their frontmatter and become date-grouped, newest first
 *  - agent concepts' string `sources:` (read-source opt-ins) become
 *    `context-sources:` - v0.2 reserves `sources:` for provenance
 *  - `status: active` / `status: unverified` go: absent status already means
 *    stable, and absent `verified` already means unverified
 *
 * Everything that needs judgment - other domain `status:` values, who
 * verified what, provenance strings, legacy `timestamp` / `# Citations` - is
 * REPORTED as a leftover, never guessed. A wrong `verified: human:` would
 * forge a trust tier; leaving it out only understates one.
 */

export interface MigrationChange {
  path: string;
  what: string;
}

export interface MigrationLeftover {
  path: string;
  rule: string;
  detail: string;
}

export interface MigrationResult {
  files: Map<string, string>;
  changes: MigrationChange[];
  leftovers: MigrationLeftover[];
}

const DROPPABLE_STATUS = new Set(["active", "unverified"]);

function splitFrontmatter(raw: string): { fm: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(raw);
  return m ? { fm: m[1]!, body: raw.slice(m[0].length) } : null;
}

function join(fm: string, body: string): string {
  return `---\n${fm}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

export function migrateFile(relPath: string, raw: string): { text: string; changes: string[]; leftovers: Omit<MigrationLeftover, "path">[] } {
  const changes: string[] = [];
  const leftovers: Omit<MigrationLeftover, "path">[] = [];
  const name = relPath.replace(/^.*\//, "");

  if (name === "log.md") {
    const { text, entries, groups } = convertLegacyLog(raw);
    if (text !== raw) changes.push(`log: ${entries} entr(ies) regrouped under ${groups} date heading(s), newest first; frontmatter dropped`);
    if (/newest (entry )?last|append(ed)? at the end|add entries at the end/i.test(text)) {
      leftovers.push({ rule: "log-wording", detail: "intro prose still says entries go at the end - v0.2 logs are newest first" });
    }
    return { text, changes, leftovers };
  }

  if (name === "index.md") {
    const split = splitFrontmatter(raw);
    const isRoot = relPath === "index.md";
    let body = split ? split.body.replace(/^\s*\n/, "") : raw;
    const parsed = split ? parseConcept(raw) : null;
    const title = parsed && typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : null;
    if (title && !/^#\s+\S/m.test(body)) body = `# ${title}\n\n${body}`;
    const wanted = isRoot ? `---\nokf_version: "${OKF_VERSION}"\n---\n\n` : "";
    const text = wanted + body;
    if (text !== raw) changes.push(isRoot ? `index: frontmatter replaced by okf_version "${OKF_VERSION}"` : "index: frontmatter dropped");
    return { text, changes, leftovers };
  }

  const split = splitFrontmatter(raw);
  if (!split) return { text: raw, changes, leftovers };
  let parsed;
  try {
    parsed = parseConcept(raw);
  } catch {
    return { text: raw, changes, leftovers: [{ rule: "parse", detail: "frontmatter does not parse - fix by hand first" }] };
  }
  if (!parsed) return { text: raw, changes, leftovers };
  const fm = parsed.frontmatter;
  let lines = split.fm.split(/\r?\n/);

  // Agent read-source opt-ins → context-sources.
  if (fm.type === "agent" && Array.isArray(fm.sources) && fm.sources.every((x) => typeof x === "string")) {
    if (fm["context-sources"] !== undefined) {
      leftovers.push({ rule: "agent-sources", detail: "has both `sources:` and `context-sources:` - merge by hand" });
    } else {
      lines = lines.map((l) => l.replace(/^sources:/, "context-sources:"));
      changes.push("agent: `sources:` → `context-sources:`");
    }
  } else if (fm.sources !== undefined) {
    const list = Array.isArray(fm.sources) ? fm.sources : [fm.sources];
    const bare = list.filter((s) => typeof s !== "object" || s === null || typeof (s as { resource?: unknown }).resource !== "string");
    if (bare.length > 0) {
      leftovers.push({ rule: "sources-shape", detail: `${bare.length} \`sources\` entr(ies) are bare strings - make each \`{ id, resource, title }\`` });
    }
  }

  // Lifecycle: drop the two values that already equal the v0.2 default.
  if (typeof fm.status === "string" && DROPPABLE_STATUS.has(fm.status)) {
    const before = lines.length;
    lines = lines.filter((l) => !/^status:\s*["']?(active|unverified)["']?\s*(#.*)?$/.test(l));
    if (lines.length < before) changes.push(`status: \`${fm.status}\` dropped (v0.2 default)`);
  } else if (fm.status !== undefined && !LIFECYCLE_VALUES.includes(fm.status as (typeof LIFECYCLE_VALUES)[number])) {
    leftovers.push({ rule: "status", detail: `status ${JSON.stringify(fm.status)} is not a v0.2 lifecycle - map to verified:/stage:/status: by judgment` });
  }

  for (const key of ["source", "verified-by", "reported-by"]) {
    if (fm[key] !== undefined && fm.type !== "crm-person" && fm.type !== "crm-org") {
      leftovers.push({ rule: "provenance", detail: `\`${key}:\` is free-text provenance - fold it into \`sources:\` / \`verified:\`` });
    }
  }
  if (fm.timestamp !== undefined) leftovers.push({ rule: "timestamp", detail: "`timestamp` → `generated: { by, at }` needs the writer's actor" });
  if (/^#{1,6}\s+Citations\s*$/m.test(parsed.body)) leftovers.push({ rule: "citations", detail: "body `# Citations` → frontmatter `sources:`" });

  return { text: changes.length ? join(lines.join("\n"), split.body) : raw, changes, leftovers };
}

/** Migrate a whole bundle (relPath → raw). Reserved files and concepts alike. */
export function migrateBundle(files: Map<string, string>): MigrationResult {
  const out = new Map<string, string>();
  const changes: MigrationChange[] = [];
  const leftovers: MigrationLeftover[] = [];
  for (const [relPath, raw] of files) {
    if (!relPath.endsWith(".md")) continue;
    const r = migrateFile(relPath, raw);
    if (r.text !== raw) out.set(relPath, r.text);
    for (const what of r.changes) changes.push({ path: relPath, what });
    for (const l of r.leftovers) leftovers.push({ path: relPath, ...l });
  }
  return { files: out, changes, leftovers };
}
