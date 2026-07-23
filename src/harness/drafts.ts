import type { InstanceStore } from "../instance/store.js";
import type { InstanceConfig } from "../instance/config-core.js";
import { assertActionAllowed, GateViolation } from "../gates/gatekeeper.js";
import type { ApprovalRecord } from "../gates/approvals.js";
import type { Level } from "../autonomy/ladder.js";

/**
 * Draft requests — the schedule-request pattern generalized to artifacts.
 *
 * An agent whose whitelist permits `draft-write` may end a run (beat or
 * direction) with fenced blocks:
 *
 *   ```draft-request
 *   path: nag-prep/07-example.md
 *   ---
 *   <complete new file content — full replace, idempotent>
 *   ```
 *
 * The harness parses, gates (level + whitelist), path-jails to the
 * instance's drafts dir, writes via the store (rides the run's own flush /
 * commit on both tiers), and ledgers every application or denial. Model
 * proposes, deterministic code disposes — a promised write either lands in
 * the same run or its denial is ledgered; no acknowledged-but-unapplied
 * state can exist.
 *
 * Drafts are non-bundle artifacts: reversible via git, never validated as
 * concepts, never delivered externally. That risk class is why the action
 * is L3-reversible rather than human-gated.
 */

export interface DraftRequest {
  /** Path relative to the instance's drafts dir, as the model wrote it. */
  path: string;
  content: string;
}

export const MAX_DRAFT_BYTES = 48 * 1024;
export const MAX_DRAFTS_PER_RUN = 4;

const BLOCK_RE = /```draft-request\s*\r?\npath:[ \t]*(.+?)[ \t]*\r?\n---\r?\n([\s\S]*?)```/g;

/**
 * Extract every `draft-request` block. Advisory model output: malformed
 * blocks are skipped, never a throw. The gate decides whether well-formed
 * requests apply.
 */
export function parseDraftRequests(text: string): DraftRequest[] {
  const out: DraftRequest[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const path = m[1]?.trim();
    const content = m[2] ?? "";
    if (path && content.trim().length > 0) out.push({ path, content });
  }
  return out;
}

/** Remove draft-request blocks from text bound for a chat reply. */
export function stripDraftRequests(text: string): string {
  return text.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n");
}

/**
 * Jail check: the path must resolve to a plain file strictly inside the
 * drafts dir. Returns the reason a path is rejected, or null when clean.
 * Pure string logic (Workers-safe, no node:path).
 */
export function draftPathViolation(relPath: string): string | null {
  if (relPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relPath)) return "absolute paths are not allowed";
  if (relPath.includes("\\")) return "backslashes are not allowed";
  const segments = relPath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return "path may not contain empty, '.' or '..' segments";
  }
  if (!/\.md$/i.test(relPath)) return "drafts must be .md files";
  return null;
}

export interface ApplyDraftsOptions {
  store: InstanceStore;
  config: InstanceConfig;
  agent: { name: string; level: Level; whitelist: string[] };
  runId: string;
  gatedTypes: string[];
  approvals: Map<string, ApprovalRecord>;
  clock: () => string;
  text: string;
  progress: (note: string) => void;
}

/** Paths (instance-relative) actually written this run. */
export async function applyDraftRequests(options: ApplyDraftsOptions): Promise<string[]> {
  const { store, config, agent, runId, clock, progress } = options;
  const requests = parseDraftRequests(options.text);
  if (requests.length === 0) return [];

  // One gate decision for the batch — the same call shape as every other
  // reversible action. A denial ledgers ALL requested paths and applies none.
  try {
    assertActionAllowed({
      agent: agent.name,
      level: agent.level,
      category: "reversible",
      actionType: "draft-write",
      gatedTypes: options.gatedTypes,
      approvals: { get: (id) => options.approvals.get(id) },
      whitelist: agent.whitelist,
    });
  } catch (err) {
    if (!(err instanceof GateViolation)) throw err;
    await store.appendLedger({
      ts: clock(),
      runId,
      agent: agent.name,
      action: "draft-request-denied",
      type: "draft-write",
      detail: { paths: requests.map((r) => r.path), reason: err.message },
    });
    progress(`run ${runId.slice(0, 8)}: draft-request denied — ${err.message}`);
    return [];
  }

  const written: string[] = [];
  for (const req of requests.slice(0, MAX_DRAFTS_PER_RUN)) {
    // Models routinely write the drafts dir into the path ("drafts/x.md")
    // even when asked for a subpath — strip it rather than nest it.
    const sub = req.path.startsWith(`${config.drafts}/`) ? req.path.slice(config.drafts.length + 1) : req.path;
    const violation =
      draftPathViolation(sub) ??
      (req.content.length > MAX_DRAFT_BYTES ? `content exceeds ${MAX_DRAFT_BYTES} bytes` : null);
    if (violation) {
      await store.appendLedger({
        ts: clock(),
        runId,
        agent: agent.name,
        action: "draft-request-denied",
        type: "draft-write",
        detail: { paths: [req.path], reason: violation },
      });
      progress(`run ${runId.slice(0, 8)}: draft-request rejected (${req.path}) — ${violation}`);
      continue;
    }
    const rel = `${config.drafts}/${sub}`;
    await store.writeFile(rel, req.content);
    await store.appendLedger({
      ts: clock(),
      runId,
      agent: agent.name,
      action: "draft-written",
      type: "draft-write",
      detail: { path: rel, bytes: req.content.length },
    });
    progress(`run ${runId.slice(0, 8)}: draft written — ${rel}`);
    written.push(rel);
  }
  const overflow = requests.slice(MAX_DRAFTS_PER_RUN);
  if (overflow.length > 0) {
    await store.appendLedger({
      ts: clock(),
      runId,
      agent: agent.name,
      action: "draft-request-denied",
      type: "draft-write",
      detail: { paths: overflow.map((r) => r.path), reason: `over the ${MAX_DRAFTS_PER_RUN}-drafts-per-run cap` },
    });
  }
  return written;
}

/** Prompt advertisement — only offered when the whitelist would allow it. */
export function draftCapabilityLines(draftsDir: string): string[] {
  return [
    `- You may create or update working artifacts under \`${draftsDir}/\` (session prep, outlines,`,
    "  quiz sheets — never bundle concepts). End your output with one fenced block PER FILE",
    "  (full replacement content, ≤4 files per run, .md only). `path` is RELATIVE to the",
    `  drafts dir — write \`nag-prep/07-x.md\`, not \`${draftsDir}/nag-prep/07-x.md\`:`,
    "  ```draft-request",
    "  path: <subpath>.md",
    "  ---",
    "  <complete file content>",
    "  ```",
    "  The harness applies each through your whitelist gate, commits it with this run, and",
    "  records it in the ledger. Reference the draft's path in your report so readers find it.",
  ];
}
