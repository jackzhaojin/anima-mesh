/**
 * Where a brain lives (v2.3.7): a git repository, or a folder a sync client
 * keeps on every machine (OneDrive, SharePoint, Google Drive, Dropbox).
 *
 * Git merges; a sync client does not. When two machines change the same
 * file it keeps both, under a "conflict copy" name, and an engine that read
 * every `.md` as a concept would quietly load both versions of a fact. The
 * same clients also refuse names that Windows or SharePoint refuse. These
 * checks are pure path logic (Workers-safe), shared by `validate`,
 * `doctor` and the beat's note to the hub.
 */

export type StorageKind = "git" | "synced";

/** A recognizable conflict-copy name, or null. `siblings` = names in the same folder. */
export function conflictCopyReason(name: string, siblings: ReadonlySet<string>): string | null {
  if (/conflicted copy/i.test(name)) return "Dropbox conflicted copy";
  if (/\((?:conflict|conflicted)[^)]*\)/i.test(name) || /\bconflict-\d{4}/i.test(name)) return "sync conflict copy";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  // Google Drive, OneDrive web and most clients: "name (1).md" beside "name.md".
  const numbered = /^(.*) \((\d+)\)$/.exec(stem);
  if (numbered && siblings.has(`${numbered[1]}${ext}`)) return `duplicate of ${numbered[1]}${ext}`;
  // OneDrive desktop: "name-COMPUTERNAME.md" (sometimes "-COMPUTERNAME-2")
  // beside "name.md". Machine names are upper case; slugs are lower case.
  // Machine names may hold dashes themselves, so try every split point.
  for (let i = stem.indexOf("-"); i > 0; i = stem.indexOf("-", i + 1)) {
    const base = stem.slice(0, i);
    const suffix = stem.slice(i + 1);
    if (/^[A-Z0-9][A-Z0-9_-]*$/.test(suffix) && /[A-Z]/.test(suffix) && siblings.has(`${base}${ext}`)) {
      return `OneDrive conflict copy of ${base}${ext} (from ${suffix})`;
    }
  }
  return null;
}

/** Every conflict copy among bundle-relative paths, with why it looks like one. */
export function conflictCopies(relPaths: readonly string[]): Array<{ path: string; reason: string }> {
  const byDir = new Map<string, Set<string>>();
  for (const p of relPaths) {
    const i = p.lastIndexOf("/");
    const dir = i === -1 ? "" : p.slice(0, i);
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir)!.add(p.slice(i + 1));
  }
  const out: Array<{ path: string; reason: string }> = [];
  for (const [dir, names] of byDir) {
    for (const name of names) {
      const reason = conflictCopyReason(name, names);
      if (reason) out.push({ path: dir ? `${dir}/${name}` : name, reason });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const ILLEGAL_CHARS = /[<>:"|?*\\\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const RESERVED_NAMES = new Set([".lock", "desktop.ini", "_vti_"]);
/** Leaves room for a brain root of ~60 characters under Windows' 260. */
export const MAX_PORTABLE_REL_PATH = 200;

/**
 * Names that break on Windows, OneDrive or SharePoint, case-only collisions
 * (one file on macOS and Windows), and paths too long to sync everywhere.
 */
export function portabilityIssues(relPaths: readonly string[]): Array<{ path: string; problem: string }> {
  const out: Array<{ path: string; problem: string }> = [];
  const seen = new Map<string, string>();
  for (const p of relPaths) {
    for (const seg of p.split("/")) {
      if (ILLEGAL_CHARS.test(seg)) out.push({ path: p, problem: `"${seg}" has a character Windows/OneDrive refuse (< > : " | ? * \\)` });
      else if (/[ .]$/.test(seg)) out.push({ path: p, problem: `"${seg}" ends with a space or dot` });
      else if (RESERVED.test(seg) || RESERVED_NAMES.has(seg.toLowerCase()) || seg.startsWith("~$")) {
        out.push({ path: p, problem: `"${seg}" is a reserved or lock-file name` });
      }
    }
    if (p.length > MAX_PORTABLE_REL_PATH) out.push({ path: p, problem: `path is ${p.length} characters; keep under ${MAX_PORTABLE_REL_PATH}` });
    const lower = p.toLowerCase();
    const other = seen.get(lower);
    if (other !== undefined && other !== p) out.push({ path: p, problem: `differs from ${other} only by letter case` });
    else seen.set(lower, p);
  }
  return out;
}

/** A machine id usable in a file name: ANIMAMESH_WRITER, else the host name. */
export function sanitizeWriter(raw: string): string {
  const s = raw.toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "machine";
}
