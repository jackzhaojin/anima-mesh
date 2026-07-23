import type { InstanceConfig } from "../instance/config-core.js";

/**
 * Defect reports — the mesh's feedback loop INTO the engine.
 *
 * An agent whose whitelist permits `defect-report` may end a run (beat or
 * direction) with fenced blocks:
 *
 *   ```defect-report
 *   title: <one line, engine-generic>
 *   ---
 *   <repro steps, expected vs actual, engine version if known>
 *   ```
 *
 * The harness parses, gates (level + whitelist), runs the identity-leak
 * guard (the engine repo is PUBLIC — instance identity never crosses D2/D13),
 * files a GitHub issue on `config.engine.repo`, and ledgers every filing or
 * denial. Model proposes, deterministic code disposes — a leaky report is
 * DENIED with the reason ledgered, never rewritten.
 *
 * Workers-safe: fetch + string logic only.
 */

export interface DefectReport {
  title: string;
  body: string;
}

export const MAX_DEFECTS_PER_RUN = 2;
export const MAX_DEFECT_BYTES = 16 * 1024;
export const DEFECT_LABEL = "defect";

const BLOCK_RE = /```defect-report\s*\r?\ntitle:[ \t]*(.+?)[ \t]*\r?\n---\r?\n([\s\S]*?)```/g;

/** Extract every `defect-report` block. Malformed blocks are skipped, never a throw. */
export function parseDefectReports(text: string): DefectReport[] {
  const out: DefectReport[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const title = m[1]?.trim();
    const body = (m[2] ?? "").trim();
    if (title && body.length > 0) out.push({ title, body });
  }
  return out;
}

/** Remove defect-report blocks from text bound for a chat reply. */
export function stripDefectReports(text: string): string {
  return text.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n");
}

/** `github.com/owner/name` (or a URL, or bare `owner/name`) → `owner/name`, else null. */
export function engineRepoSlug(config: InstanceConfig): string | null {
  const repo = config.engine?.repo;
  if (!repo) return null;
  const slug = repo
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * D2/D13 enforcement for the public surface: returns every instance-identity
 * token (principal/persona name words ≥3 chars, any configured email) found
 * in the text. Non-empty result ⇒ the report must be denied.
 */
export function identityLeakGuard(text: string, config: InstanceConfig): string[] {
  const words = new Set<string>();
  const addName = (name?: string) => {
    for (const w of (name ?? "").split(/\s+/)) {
      const t = w.trim();
      if (t.length >= 3) words.add(t);
    }
  };
  addName(config.identity?.principal?.name);
  addName(config.identity?.persona?.name);
  const emails = [config.identity?.principal?.email, ...(config.identity?.persona?.emails ?? [])].filter(
    (e): e is string => typeof e === "string" && e.length > 0,
  );

  const leaked: string[] = [];
  for (const w of words) {
    if (new RegExp(`\\b${escapeRe(w)}\\b`, "i").test(text)) leaked.push(w);
  }
  const lower = text.toLowerCase();
  for (const e of emails) {
    if (lower.includes(e.toLowerCase())) leaked.push(e);
  }
  return leaked;
}

export interface DefectIssueResult {
  url: string;
  number: number;
  /** True when an open issue with the same title already carried this defect. */
  duplicate: boolean;
}

export interface CreateDefectIssueOptions {
  /** `owner/name`. */
  repo: string;
  title: string;
  body: string;
  token: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

/**
 * File the issue (label `defect`), deduping against open defect issues by
 * normalized title first — a recurring engine bug is one issue, not one per
 * beat. Dedup is best-effort: if the listing fails we file anyway.
 */
export async function createDefectIssue(options: CreateDefectIssueOptions): Promise<DefectIssueResult> {
  const f = options.fetchImpl ?? fetch;
  const api = options.apiBase ?? "https://api.github.com";
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    // Workers send no default UA and GitHub 403s UA-less calls (learning 2026-07-18).
    "user-agent": "anima-mesh",
    "content-type": "application/json",
  };

  const norm = (s: string) => s.trim().toLowerCase();
  try {
    const res = await f(`${api}/repos/${options.repo}/issues?state=open&labels=${DEFECT_LABEL}&per_page=100`, {
      headers,
    });
    if (res.ok) {
      const list = (await res.json()) as { title: string; html_url: string; number: number }[];
      const hit = list.find((i) => norm(i.title) === norm(options.title));
      if (hit) return { url: hit.html_url, number: hit.number, duplicate: true };
    }
  } catch {
    /* dedup unavailable → create anyway */
  }

  const res = await f(`${api}/repos/${options.repo}/issues`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: options.title, body: options.body, labels: [DEFECT_LABEL] }),
  });
  if (res.status !== 201) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`GitHub issue create failed on ${options.repo}: ${res.status} ${detail}`);
  }
  const issue = (await res.json()) as { html_url: string; number: number };
  return { url: issue.html_url, number: issue.number, duplicate: false };
}

/** Prompt advertisement — only offered when the whitelist would allow it. */
export function defectCapabilityLines(engineRepo: string): string[] {
  return [
    "- ENGINE feedback loop: if THIS RUN hit an AnimaMesh engine defect (harness/CLI/Workers",
    "  misbehavior — not instance content), you may file it as a GitHub issue on the public",
    `  engine repo (\`${engineRepo}\`). End your output with at most ${MAX_DEFECTS_PER_RUN} blocks:`,
    "  ```defect-report",
    "  title: <one line, engine-generic>",
    "  ---",
    "  <repro, expected vs actual, engine version if known>",
    "  ```",
    "  The repo is PUBLIC: never include the organization's, principal's, or persona's names,",
    "  emails, or bundle content — describe mechanics generically. The harness gates each block,",
    "  files the issue, and ledgers the URL; leaky or malformed reports are denied, never rewritten.",
  ];
}
