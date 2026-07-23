import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { loadInstance } from "../instance/config.js";
import { parseConcept } from "../okf/frontmatter.js";
import {
  createDefectIssue,
  defectDraftContent,
  engineRepoSlug,
  identityLeakGuard,
} from "./report-core.js";

/**
 * The deliberate half of the drafts-first defect loop (Node/CLI only):
 * defect drafts accumulate in `<drafts>/defects/` with no credential at
 * all; THIS is where a human (or a local session) promotes them to GitHub
 * issues on the public engine repo. The leak guard re-runs here on the
 * CURRENT file content — a human may have edited the draft since the run —
 * and a leaking draft is skipped, never filed, never rewritten.
 */

export interface DefectDraft {
  /** Filename without .md — the stable per-defect key. */
  slug: string;
  /** Instance-relative path. */
  relPath: string;
  title: string;
  body: string;
  agent?: string;
  runId?: string;
  lastSeen?: string;
  /** Issue URL when already filed. */
  filedUrl?: string;
  /** Leak-guard hits against the CURRENT content. */
  leaked: string[];
}

export function listDefectDrafts(instanceRoot: string): DefectDraft[] {
  const instance = loadInstance(instanceRoot);
  const dir = path.join(instance.draftsDir, "defects");
  if (!existsSync(dir)) return [];
  const out: DefectDraft[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const raw = readFileSync(path.join(dir, name), "utf8");
    const parsed = parseConcept(raw);
    if (!parsed) continue;
    const fm = parsed.frontmatter;
    const title = typeof fm.title === "string" && fm.title.trim() ? fm.title : name.replace(/\.md$/, "");
    const filed = typeof fm.filed === "string" && /^https?:\/\//.test(fm.filed) ? fm.filed : undefined;
    out.push({
      slug: name.replace(/\.md$/, ""),
      relPath: `${instance.config.drafts}/defects/${name}`,
      title,
      body: parsed.body.trim(),
      agent: typeof fm.agent === "string" ? fm.agent : undefined,
      runId: typeof fm.runId === "string" ? fm.runId : undefined,
      lastSeen: typeof fm["last-seen"] === "string" ? (fm["last-seen"] as string) : undefined,
      filedUrl: filed,
      leaked: identityLeakGuard(`${title}\n${parsed.body}`, instance.config),
    });
  }
  return out;
}

export interface FileDefectsOptions {
  instanceRoot: string;
  /** Specific slugs; absent + all=false files nothing (list-only safety). */
  slugs?: string[];
  all?: boolean;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface FileDefectsResult {
  filed: { slug: string; url: string; duplicate: boolean }[];
  skipped: { slug: string; reason: string }[];
}

export async function fileDefectDrafts(options: FileDefectsOptions): Promise<FileDefectsResult> {
  const instance = loadInstance(options.instanceRoot);
  const repo = engineRepoSlug(instance.config);
  if (!repo) throw new Error("config.engine.repo is missing or not owner/name-shaped — nowhere to file");

  const drafts = listDefectDrafts(options.instanceRoot);
  const wanted = options.all
    ? drafts
    : (options.slugs ?? []).map((s) => {
        const found = drafts.find((d) => d.slug === s);
        if (!found) {
          throw new Error(`no defect draft '${s}' — available: ${drafts.map((d) => d.slug).join(", ") || "(none)"}`);
        }
        return found;
      });

  const result: FileDefectsResult = { filed: [], skipped: [] };
  for (const draft of wanted) {
    if (draft.filedUrl) {
      result.skipped.push({ slug: draft.slug, reason: `already filed: ${draft.filedUrl}` });
      continue;
    }
    if (draft.leaked.length > 0) {
      result.skipped.push({
        slug: draft.slug,
        reason: `identity leak — de-identify the draft first (contains: ${draft.leaked.join(", ")})`,
      });
      continue;
    }
    const issue = await createDefectIssue({
      repo,
      title: draft.title,
      body: draft.body,
      token: options.token,
      fetchImpl: options.fetchImpl,
    });
    const abs = path.join(instance.root, draft.relPath);
    writeFileSync(
      abs,
      defectDraftContent({
        title: draft.title,
        body: draft.body,
        agent: draft.agent ?? "unknown",
        runId: draft.runId ?? "manual",
        seenAt: draft.lastSeen ?? new Date().toISOString(),
        filedUrl: issue.url,
      }),
      "utf8",
    );
    result.filed.push({ slug: draft.slug, url: issue.url, duplicate: issue.duplicate });
  }
  return result;
}
