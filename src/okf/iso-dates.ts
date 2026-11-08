/**
 * ISO 8601 dates in names (v2.4.1). Dated files and folders read
 * `2026-10-30-slug.md`, never `20261030-slug.md`: the same `YYYY-MM-DD` a
 * concept's `date:` and the log's headings already use. Pure and
 * Workers-safe - conformance warns with `isoDateName`, and
 * `anima-mesh okf iso-dates` plans the one-time rename with `planIsoDates`.
 *
 * The rewrite is exact, never a blind 8-digit search: it replaces only the
 * names this tree actually renames, so an ID, a membership number or a
 * `touch -t` timestamp that happens to look like a date is left alone.
 * Mentions it cannot resolve (a linked brain's file, prose about the old
 * style) are REPORTED, never guessed.
 */

const COMPACT_RE = /^(\d{4})(\d{2})(\d{2})(?=$|[-_.])/;

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2099 || m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}

/** The ISO form of one path segment that starts with a compact `yyyymmdd`, else null. */
export function isoDateName(segment: string): string | null {
  const m = COMPACT_RE.exec(segment);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (!validDate(Number(y), Number(mo), Number(d))) return null;
  return `${y}-${mo}-${d}${segment.slice(8)}`;
}

/** The whole relative path with every compact dated segment made ISO. */
export function isoDatePath(relPath: string): string {
  return relPath
    .split("/")
    .map((s) => isoDateName(s) ?? s)
    .join("/");
}

export interface IsoDatePlan {
  /** Files to move, old relPath → new relPath. */
  renames: Array<{ from: string; to: string }>;
  /** Renames refused because the ISO name is already taken. Any clash means: change nothing. */
  clashes: Array<{ from: string; to: string }>;
  /** Text files whose references change, keyed by their OLD relPath, with the new text. */
  rewrites: Map<string, string>;
  /** How many references each rewritten file had. */
  counts: Map<string, number>;
  /** Compact dated names still mentioned after the rewrite, with no matching file here. */
  unresolved: Array<{ path: string; name: string }>;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Old name tokens this tree renames: a dated folder's full name, a dated file's name without its extension. */
function renamedTokens(paths: string[]): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const p of paths) {
    const segs = p.split("/");
    segs.forEach((seg, i) => {
      const iso = isoDateName(seg);
      if (!iso) return;
      const isFile = i === segs.length - 1;
      const dot = isFile ? seg.lastIndexOf(".") : -1;
      const stem = dot > 8 ? seg.slice(0, dot) : seg;
      tokens.set(stem, isoDateName(stem)!);
    });
  }
  return tokens;
}

/**
 * Rewrite every mention of a renamed token. A token is matched whole: not
 * preceded by a letter, digit or underscore, and not followed by one or by a
 * hyphen (so `2026-10-30-a` never eats part of `2026-10-30-ab`). A bare
 * `yyyymmdd` token (no slug) is only rewritten where it sits in a path.
 */
export function rewriteReferences(text: string, tokens: Map<string, string>): { text: string; count: number } {
  if (tokens.size === 0) return { text, count: 0 };
  const slugged = [...tokens.keys()].filter((t) => t.length > 8).sort((a, b) => b.length - a.length);
  const bare = [...tokens.keys()].filter((t) => t.length === 8);
  let count = 0;
  let out = text;
  if (slugged.length) {
    const re = new RegExp(`(?<![A-Za-z0-9_])(${slugged.map(escapeRe).join("|")})(?![A-Za-z0-9_-])`, "g");
    out = out.replace(re, (t) => {
      count++;
      return tokens.get(t)!;
    });
  }
  for (const t of bare) {
    const re = new RegExp(`(?<=/)${t}(?=/)|(?<=/)${t}(?![A-Za-z0-9_-])|(?<![A-Za-z0-9_])${t}(?=/)`, "g");
    out = out.replace(re, () => {
      count++;
      return tokens.get(t)!;
    });
  }
  return { text: out, count };
}

const MENTION_RE = /(?<![A-Za-z0-9_])(\d{8})(-[A-Za-z0-9][A-Za-z0-9_-]*)/g;

/** Compact dated names (`yyyymmdd-slug`) a text still mentions. */
export function compactMentions(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    if (isoDateName(m[1]!)) found.add(`${m[1]}${m[2]}`);
  }
  return [...found];
}

/**
 * Plan the rename for a tree. `paths` lists every file (relative, `/`
 * separators); `texts` holds the contents of the text files whose references
 * should follow. Excluding the ledger and lockfiles is the caller's job.
 */
export function planIsoDates(paths: string[], texts: Map<string, string>): IsoDatePlan {
  const existing = new Set(paths);
  const renames: IsoDatePlan["renames"] = [];
  const clashes: IsoDatePlan["clashes"] = [];
  const targets = new Set<string>();
  for (const from of [...paths].sort()) {
    const to = isoDatePath(from);
    if (to === from) continue;
    if (existing.has(to) || targets.has(to)) clashes.push({ from, to });
    else {
      renames.push({ from, to });
      targets.add(to);
    }
  }
  const tokens = renamedTokens(renames.map((r) => r.from));
  const rewrites = new Map<string, string>();
  const counts = new Map<string, number>();
  const unresolved: IsoDatePlan["unresolved"] = [];
  for (const [p, raw] of [...texts].sort(([a], [b]) => a.localeCompare(b))) {
    const { text, count } = rewriteReferences(raw, tokens);
    if (count > 0) {
      rewrites.set(p, text);
      counts.set(p, count);
    }
    for (const name of compactMentions(text)) unresolved.push({ path: isoDatePath(p), name });
  }
  return { renames, clashes, rewrites, counts, unresolved };
}
