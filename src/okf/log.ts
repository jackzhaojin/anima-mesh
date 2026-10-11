/**
 * OKF v0.2 log files (SPEC §9): a flat list of date-grouped entries,
 * NEWEST FIRST, under `## YYYY-MM-DD` headings. Pure and Workers-safe.
 *
 * ```markdown
 * # Bundle log
 *
 * ## 2026-10-11
 * - **Update**: Pinned engine v2.2.0.
 *
 * ## 2026-10-10
 * - **Creation**: Brain scaffolded.
 * ```
 *
 * Writers go through `addLogEntry` so the engine never appends to the
 * bottom again; `convertLegacyLog` is the one-time migration for logs
 * written the v0.1-era AnimaMesh way (newest last, `- **date** -` bullets
 * and `## date (qualifier) - title` sections). Conversion moves entries,
 * never rewrites their words.
 */

const DATE_HEADING_RE = /^## (\d{4}-\d{2}-\d{2})\s*$/;
const ANY_H2_RE = /^## (.*)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface LogIssue {
  level: "warning";
  rule: string;
  message: string;
}

/** Strip an optional frontmatter block (legacy `type: log`) and return the body. */
function stripFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(raw);
  return m ? { frontmatter: m[1]!, body: raw.slice(m[0].length) } : { frontmatter: null, body: raw };
}

/**
 * SPEC §9 structure, as warnings: frontmatter, non-date H2s, and order.
 * Pass the raw file, or an already-split body with `hadFrontmatter`.
 */
export function checkLog(raw: string, opts: { hadFrontmatter?: boolean } = {}): LogIssue[] {
  const issues: LogIssue[] = [];
  const split = opts.hadFrontmatter === undefined ? stripFrontmatter(raw) : { frontmatter: opts.hadFrontmatter ? "" : null, body: raw };
  const { frontmatter, body } = split;
  if (frontmatter !== null) {
    issues.push({ level: "warning", rule: "okf/log-frontmatter", message: "log.md carries frontmatter; OKF v0.2 log files have none" });
  }
  const dates: string[] = [];
  let bad = 0;
  let firstBad = "";
  for (const line of body.split(/\r?\n/)) {
    const h2 = ANY_H2_RE.exec(line);
    if (!h2) continue;
    const d = DATE_HEADING_RE.exec(line);
    if (d) dates.push(d[1]!);
    else if (bad++ === 0) firstBad = line;
  }
  if (bad > 0) {
    issues.push({
      level: "warning",
      rule: "okf/log-date-heading",
      message: `${bad} \`##\` heading(s) are not a bare ISO date (first: ${JSON.stringify(firstBad)}); entries group under \`## YYYY-MM-DD\``,
    });
  }
  for (let i = 1; i < dates.length; i++) {
    if (dates[i]! >= dates[i - 1]!) {
      issues.push({
        level: "warning",
        rule: "okf/log-order",
        message: `date groups must be newest first and unique (## ${dates[i]} follows ## ${dates[i - 1]})`,
      });
      break;
    }
  }
  if (dates.length === 0 && /^\s*[-*] \*\*\d{4}-\d{2}-\d{2}\*\*/m.test(body)) {
    issues.push({ level: "warning", rule: "okf/log-date-heading", message: "entries are dated bullets with no `## YYYY-MM-DD` groups" });
  }
  return issues;
}

/**
 * Insert one entry, newest first: at the top of today's group, creating the
 * group above every older one. `entry` is markdown (conventionally a bullet
 * led by a bold verb: `- **Update**: ...`). A missing file gets a header.
 */
export function addLogEntry(raw: string | null, date: string, entry: string): string {
  if (!ISO_DATE_RE.test(date)) throw new Error(`log date must be YYYY-MM-DD, got '${date}'`);
  const text = entry.trim();
  const base = raw ?? "# Bundle log\n";
  const lines = base.replace(/\s+$/, "").split("\n");
  const firstDate = lines.findIndex((l) => DATE_HEADING_RE.test(l));
  if (firstDate !== -1 && DATE_HEADING_RE.exec(lines[firstDate]!)![1] === date) {
    lines.splice(firstDate + 1, 0, "", text);
  } else if (firstDate !== -1) {
    lines.splice(firstDate, 0, `## ${date}`, "", text, "");
  } else {
    lines.push("", `## ${date}`, "", text);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

interface LegacyEntry {
  date: string;
  seq: number;
  lines: string[];
}

const LEGACY_BULLET_RE = /^[-*] \*\*(\d{4}-\d{2}-\d{2})\*\*\s*(?:[—–-]+\s*|:\s*)?(.*)$/;
const LEGACY_SECTION_RE = /^## (\d{4}-\d{2}-\d{2})\b\s*(.*)$/;

function sectionHeading(rest: string): string | null {
  let r = rest.trim();
  let qualifier = "";
  const q = /^\(([^)]*)\)\s*/.exec(r);
  if (q) {
    qualifier = q[1]!.trim();
    r = r.slice(q[0].length);
  }
  r = r.replace(/^[—–:-]+\s*/, "").trim();
  if (!r && !qualifier) return null;
  return `### ${r || qualifier}${r && qualifier ? ` (${qualifier})` : ""}`;
}

/**
 * Convert a legacy newest-last log into SPEC §9 form. Entry boundaries are
 * column-0 `- **YYYY-MM-DD**` bullets and `## YYYY-MM-DD ...` sections; an
 * entry runs to the next boundary. Entries keep their words; a section's
 * `(qualifier) - title` becomes a `### title (qualifier)` subheading under
 * its bare date group. The preamble (H1 + intro prose) is kept verbatim -
 * the caller fixes any "newest last" wording by hand.
 */
export function convertLegacyLog(raw: string): { text: string; entries: number; groups: number } {
  const { body } = stripFrontmatter(raw);
  const lines = body.split(/\r?\n/);
  const preamble: string[] = [];
  const entries: LegacyEntry[] = [];
  let current: LegacyEntry | null = null;
  let seq = 0;
  for (const line of lines) {
    const bullet = LEGACY_BULLET_RE.exec(line);
    const section = bullet ? null : LEGACY_SECTION_RE.exec(line);
    const bareDate = DATE_HEADING_RE.exec(line);
    if (bullet) {
      current = { date: bullet[1]!, seq: seq++, lines: [`- ${bullet[2]!}`] };
      entries.push(current);
    } else if (section) {
      const heading = bareDate ? null : sectionHeading(section[2]!);
      current = { date: section[1]!, seq: seq++, lines: heading ? [heading] : [] };
      entries.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  // Newest first; within a day, the entry written last comes first.
  entries.sort((a, b) => (a.date === b.date ? b.seq - a.seq : a.date < b.date ? 1 : -1));
  const out: string[] = [preamble.join("\n").trim()];
  let group = "";
  let groups = 0;
  for (const e of entries) {
    if (e.date !== group) {
      out.push(`## ${e.date}`);
      group = e.date;
      groups++;
    }
    const chunk = e.lines.join("\n").trim();
    if (chunk) out.push(chunk);
  }
  return { text: out.filter((s) => s !== "").join("\n\n").replace(/\n{3,}/g, "\n\n") + "\n", entries: entries.length, groups };
}
