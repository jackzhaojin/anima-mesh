import type { InstanceStore } from "../instance/store.js";
import type { InstanceConfig } from "../instance/config-core.js";
import { assertActionAllowed, GateViolation } from "../gates/gatekeeper.js";
import type { ApprovalRecord } from "../gates/approvals.js";
import type { Level } from "../autonomy/ladder.js";
import { getEnv } from "../instance/env-core.js";
import {
  parseDefectReports,
  engineRepoSlug,
  identityLeakGuard,
  createDefectIssue,
  defectDraftSlug,
  defectDraftContent,
  MAX_DEFECTS_PER_RUN,
  MAX_DEFECT_BYTES,
} from "../defects/report-core.js";

/**
 * Apply `defect-report` blocks from a run's output — DRAFTS-FIRST: parse →
 * gate (level + whitelist, one decision for the batch) → save each report
 * as `<drafts>/defects/<slug>.md` via the store, riding the run's own
 * commit. No credential needed on any tier; the instance's existing write
 * path (GitHub App on the cloud) is enough. See defects/report-core.ts for
 * the block format and rationale.
 *
 * Filing to the public engine repo happens in-run ONLY when
 * `GITHUB_DEFECTS_TOKEN` is explicitly configured (an opt-in, not a
 * requirement) AND the identity-leak guard passes; otherwise drafts wait
 * for `anima-mesh defect file` (defects/file.ts). Leak hits are recorded
 * on the draft and ledgered — the private draft is safe to keep either way.
 */

export interface ApplyDefectsOptions {
  store: InstanceStore;
  config: InstanceConfig;
  agent: { name: string; level: Level; whitelist: string[] };
  runId: string;
  gatedTypes: string[];
  approvals: Map<string, ApprovalRecord>;
  clock: () => string;
  text: string;
  progress: (note: string) => void;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** Instance-relative draft paths written this run. */
export async function applyDefectReports(options: ApplyDefectsOptions): Promise<string[]> {
  const { store, config, agent, runId, clock, progress } = options;
  const reports = parseDefectReports(options.text);
  if (reports.length === 0) return [];

  const deny = async (titles: string[], reason: string) => {
    await store.appendLedger({
      ts: clock(),
      runId,
      agent: agent.name,
      action: "defect-report-denied",
      type: "defect-report",
      detail: { titles, reason },
    });
    progress(`run ${runId.slice(0, 8)}: defect-report denied — ${reason}`);
  };

  // One gate decision for the batch — the same call shape as every other
  // reversible action. A denial ledgers ALL requested titles and saves none.
  try {
    assertActionAllowed({
      agent: agent.name,
      level: agent.level,
      category: "reversible",
      actionType: "defect-report",
      gatedTypes: options.gatedTypes,
      approvals: { get: (id) => options.approvals.get(id) },
      whitelist: agent.whitelist,
    });
  } catch (err) {
    if (!(err instanceof GateViolation)) throw err;
    await deny(reports.map((r) => r.title), err.message);
    return [];
  }

  // Auto-filing is an explicit opt-in — never the App/store credential, so
  // an unconfigured instance produces clean drafts, not a 404 per beat.
  const autoFileToken = getEnv(options.env, "GITHUB_DEFECTS_TOKEN");
  const repo = engineRepoSlug(config);

  const written: string[] = [];
  for (const report of reports.slice(0, MAX_DEFECTS_PER_RUN)) {
    if (report.body.length > MAX_DEFECT_BYTES) {
      await deny([report.title], `body exceeds ${MAX_DEFECT_BYTES} bytes`);
      continue;
    }
    const leaked = identityLeakGuard(`${report.title}\n${report.body}`, config);
    const rel = `${config.drafts}/defects/${defectDraftSlug(report.title)}.md`;
    const draft = (filedUrl?: string) =>
      defectDraftContent({
        title: report.title,
        body: report.body,
        agent: agent.name,
        runId,
        seenAt: clock(),
        leaked: leaked.length > 0 ? leaked : undefined,
        filedUrl,
      });
    await store.writeFile(rel, draft());
    await store.appendLedger({
      ts: clock(),
      runId,
      agent: agent.name,
      action: "defect-drafted",
      type: "defect-report",
      detail: { title: report.title, path: rel, ...(leaked.length > 0 ? { leakCheck: leaked } : {}) },
    });
    progress(`run ${runId.slice(0, 8)}: defect drafted — ${rel}`);
    written.push(rel);

    if (!autoFileToken) continue;
    if (!repo) {
      await store.appendLedger({
        ts: clock(),
        runId,
        agent: agent.name,
        action: "defect-file-skipped",
        type: "defect-report",
        detail: { title: report.title, reason: "config.engine.repo is missing or not owner/name-shaped" },
      });
      continue;
    }
    if (leaked.length > 0) {
      await store.appendLedger({
        ts: clock(),
        runId,
        agent: agent.name,
        action: "defect-file-skipped",
        type: "defect-report",
        detail: {
          title: report.title,
          reason: `identity leak — the engine repo is public and the report contains: ${leaked.join(", ")}`,
        },
      });
      progress(`run ${runId.slice(0, 8)}: defect filing skipped (identity leak) — draft kept at ${rel}`);
      continue;
    }
    try {
      const issue = await createDefectIssue({
        repo,
        title: report.title,
        body: report.body,
        token: autoFileToken,
        fetchImpl: options.fetchImpl,
      });
      await store.writeFile(rel, draft(issue.url));
      await store.appendLedger({
        ts: clock(),
        runId,
        agent: agent.name,
        action: "defect-filed",
        type: "defect-report",
        detail: { title: report.title, url: issue.url, number: issue.number, duplicate: issue.duplicate },
      });
      progress(`run ${runId.slice(0, 8)}: defect ${issue.duplicate ? "already filed" : "filed"} — ${issue.url}`);
    } catch (err) {
      await store.appendLedger({
        ts: clock(),
        runId,
        agent: agent.name,
        action: "defect-file-skipped",
        type: "defect-report",
        detail: { title: report.title, reason: err instanceof Error ? err.message : String(err) },
      });
      progress(`run ${runId.slice(0, 8)}: defect filing failed — draft kept at ${rel}`);
    }
  }
  const overflow = reports.slice(MAX_DEFECTS_PER_RUN);
  if (overflow.length > 0) {
    await deny(overflow.map((r) => r.title), `over the ${MAX_DEFECTS_PER_RUN}-defects-per-run cap`);
  }
  return written;
}
