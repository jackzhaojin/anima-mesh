import type { SourceContext } from "./types.js";
import { getEnv } from "../instance/env-core.js";

/**
 * The 'github-docs' source — a git-hosted document repo (mostly markdown)
 * as read context: a filing cabinet whose originals live in a GitHub repo.
 *
 * One corpus, two access paths:
 * - GitHub REST (pure fetch — this path runs on Workers): one recursive
 *   git-trees call lists every tracked file at a ref.
 * - Local working tree (Node tier only): when GITHUB_DOCS_LOCAL_PATH is set
 *   AND the harness injected ctx.sourceFs, the listing comes straight from
 *   disk — fresher (uncommitted edits show up), tokenless, no rate limit.
 *   A filesystem walk cannot see .gitignore, so untracked paths that must
 *   stay out of listings (secrets, scratch dirs) MUST be mirrored into
 *   GITHUB_DOCS_EXCLUDE; the API path only ever sees tracked files.
 *
 * Env contract (names only; values live in Worker secrets / instance .env):
 * - GITHUB_DOCS_REPO        "owner/name" — required for the API path
 * - GITHUB_DOCS_REF         optional — branch/tag/SHA; default HEAD (the
 *                           repo's default branch)
 * - GITHUB_DOCS_TOKEN       optional — fine-grained PAT, Contents READ-ONLY
 *                           on that one repo; falls back to GITHUB_TOKEN;
 *                           public repos need none
 * - GITHUB_DOCS_PATH        optional — only list paths under this subpath
 * - GITHUB_DOCS_LOCAL_PATH  optional — absolute path of a local checkout;
 *                           preferred over the API when ctx.sourceFs exists
 * - GITHUB_DOCS_EXCLUDE     optional — comma-separated names or path
 *                           prefixes omitted from the LOCAL walk (mirror
 *                           the repo's .gitignore)
 */

const API_BASE = "https://api.github.com";
const MAX_ENTRIES = 300;

export interface DocsEntry {
  /** Repo/root-relative path, e.g. "plans/2026/roadmap.md". */
  path: string;
  size?: number;
  lastModified?: string;
}

export interface DocsListing {
  entries: DocsEntry[];
  /** True when bounds (or the trees API itself) cut the listing short — never silently. */
  truncated: boolean;
  /** Where this listing came from, e.g. "owner/name@HEAD" or "local working tree /abs/path". */
  origin: string;
}

export function githubDocsConfigured(ctx: SourceContext): boolean {
  return Boolean(getEnv(ctx.env, "GITHUB_DOCS_REPO")) || Boolean(localRoot(ctx));
}

/** The local access path is live only when BOTH the env opt-in and the injected capability exist. */
function localRoot(ctx: SourceContext): string | undefined {
  const root = getEnv(ctx.env, "GITHUB_DOCS_LOCAL_PATH");
  return root && ctx.sourceFs ? root : undefined;
}

function docsToken(ctx: SourceContext): string | undefined {
  // `||` not `??`: an empty-string var counts as unset, so it falls back
  // (and, with both empty, resolves to tokenless — never a "" Bearer header).
  return getEnv(ctx.env, "GITHUB_DOCS_TOKEN") || getEnv(ctx.env, "GITHUB_TOKEN") || undefined;
}

function repoAndRef(ctx: SourceContext): { repo: string; ref: string } {
  const repo = getEnv(ctx.env, "GITHUB_DOCS_REPO");
  if (!repo) throw new Error("github-docs source: GITHUB_DOCS_REPO is not set");
  if (!/^[^/]+\/[^/#]+$/.test(repo)) {
    throw new Error(`github-docs source: GITHUB_DOCS_REPO must be "owner/name", got '${repo}'`);
  }
  return { repo, ref: getEnv(ctx.env, "GITHUB_DOCS_REF") || "HEAD" };
}

function subpathFilter(ctx: SourceContext): string {
  return (getEnv(ctx.env, "GITHUB_DOCS_PATH") ?? "").replace(/^\/+|\/+$/g, "");
}

function apiHeaders(ctx: SourceContext): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = docsToken(ctx);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

interface TreeResponse {
  tree: Array<{ path: string; type: string; size?: number }>;
  truncated?: boolean;
}

/**
 * The full document listing — local working tree when available, otherwise
 * one recursive git-trees read at the configured ref. Read-only by
 * construction: nothing here issues anything but GETs.
 */
export async function listDocs(ctx: SourceContext, opts: { maxEntries?: number } = {}): Promise<DocsListing> {
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const filter = subpathFilter(ctx);

  const root = localRoot(ctx);
  if (root) {
    const excludes = (getEnv(ctx.env, "GITHUB_DOCS_EXCLUDE") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const local = await ctx.sourceFs!.listFiles(root, { excludes, maxEntries });
    const entries = local.entries.filter((e) => inSubpath(e.path, filter));
    return { entries, truncated: local.truncated, origin: `local working tree ${root}` };
  }

  const { repo, ref } = repoAndRef(ctx);
  const doFetch = ctx.fetchImpl ?? fetch;
  const url = `${API_BASE}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const res = await doFetch(url, { headers: apiHeaders(ctx) });
  if (!res.ok) {
    // 404 on a private repo usually means the token can't see it — say so.
    const hint = res.status === 404 && !docsToken(ctx) ? " (private repo with no token?)" : "";
    throw new Error(`github-docs GET trees ${repo}@${ref} → HTTP ${res.status}${hint}`);
  }
  const json = (await res.json()) as TreeResponse;
  const files = json.tree
    .filter((item) => item.type === "blob" && inSubpath(item.path, filter))
    .sort((a, b) => a.path.localeCompare(b.path));
  const entries = files.slice(0, maxEntries).map((item) => ({ path: item.path, size: item.size }));
  return {
    entries,
    truncated: Boolean(json.truncated) || files.length > maxEntries,
    origin: `${repo}@${ref}`,
  };
}

function inSubpath(p: string, filter: string): boolean {
  return !filter || p === filter || p.startsWith(`${filter}/`);
}

const TEXT_EXTENSIONS = /\.(md|txt|csv|tsv|json|ya?ml|xml|html?|log)$/i;

/**
 * Content of one text-like document, clipped. Binary formats are refused by
 * extension — extraction pipelines belong to the instance, not a
 * prompt-assembly source.
 */
export async function readDocsFile(
  ctx: SourceContext,
  relPath: string,
  opts: { maxChars?: number } = {},
): Promise<string> {
  if (!TEXT_EXTENSIONS.test(relPath)) {
    throw new Error(`github-docs source: '${relPath}' is not a text format this source will inline`);
  }
  const maxChars = opts.maxChars ?? 20_000;

  let text: string;
  const root = localRoot(ctx);
  if (root) {
    text = await ctx.sourceFs!.readTextFile(root, relPath);
  } else {
    const { repo, ref } = repoAndRef(ctx);
    const doFetch = ctx.fetchImpl ?? fetch;
    const encoded = relPath.split("/").map(encodeURIComponent).join("/");
    const res = await doFetch(`${API_BASE}/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
      headers: { ...apiHeaders(ctx), Accept: "application/vnd.github.raw+json" },
    });
    if (!res.ok) {
      throw new Error(`github-docs GET contents ${relPath} → HTTP ${res.status}`);
    }
    text = await res.text();
  }
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text;
}

const LISTING_CHAR_BUDGET = 12_000;

/** The listing as compact markdown for prompt injection — one line per file. */
export function docsListingMarkdown(listing: DocsListing): string {
  const lines: string[] = [];
  for (const e of listing.entries) {
    const meta = [e.size !== undefined ? formatSize(e.size) : null, e.lastModified?.slice(0, 10)]
      .filter(Boolean)
      .join(", ");
    lines.push(`- ${e.path}${meta ? ` (${meta})` : ""}`);
  }
  let body = lines.join("\n");
  let clipped = false;
  if (body.length > LISTING_CHAR_BUDGET) {
    body = body.slice(0, LISTING_CHAR_BUDGET);
    body = body.slice(0, body.lastIndexOf("\n"));
    clipped = true;
  }
  const notes = [
    `${listing.entries.length} files from ${listing.origin}`,
    listing.truncated || clipped ? "listing bounded — further content exists" : null,
  ].filter(Boolean);
  return `${body}\n\n_(${notes.join("; ")})_`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
