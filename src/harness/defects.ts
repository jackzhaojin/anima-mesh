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
 * Apply `defect-report` blocks from a run's output: parse → gate (level +
 * whitelist, one decision for the batch) → ISSUE-FIRST (v0.11.4): with the
 * instance's standing PAT (`GITHUB_DEFECTS_TOKEN`, the standard posture
 * since v0.11.2) a leak-clean report files DIRECTLY to the public engine
 * repo and leaves no draft — the issue tracker is the record. A draft
 * (`<drafts>/defects/<slug>.md`, riding the run's own commit) is written
 * only when filing can't happen here: no token, missing engine.repo, an
 * identity-leak hit, or the API call failing. See defects/report-core.ts
 * for the block format and rationale.
 *
 * Draft capture needs no credential on any tier — the instance's existing
 * write path is enough — so a tokenless instance still collects drafts for
 * `anima-mesh defect file` (defects/file.ts), and the identity-leak guard
 * gates every filing path. Leak hits are recorded on the draft and
 * ledgered — the private draft is safe to keep either way.
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

/** Issue URLs filed and/or instance-relative draft paths written this run. */
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

  // Auto-filing rides the dedicated token — never the App/store credential
  // — so a tokenless instance produces clean drafts, not a 404 per beat.
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

    // Issue-first: a clean report with a token files directly and leaves no
    // draft. Every non-filing branch below falls through to the draft write.
    if (autoFileToken && repo && leaked.length === 0) {
      try {
        const issue = await createDefectIssue({
          repo,
          title: report.title,
          body: report.body,
          token: autoFileToken,
          fetchImpl: options.fetchImpl,
        });
        await store.appendLedger({
          ts: clock(),
          runId,
          agent: agent.name,
          action: "defect-filed",
          type: "defect-report",
          detail: { title: report.title, url: issue.url, number: issue.number, duplicate: issue.duplicate },
        });
        progress(`run ${runId.slice(0, 8)}: defect ${issue.duplicate ? "already filed" : "filed"} — ${issue.url}`);
        written.push(issue.url);
        continue;
      } catch (err) {
        await store.appendLedger({
          ts: clock(),
          runId,
          agent: agent.name,
          action: "defect-file-skipped",
          type: "defect-report",
          detail: { title: report.title, reason: err instanceof Error ? err.message : String(err) },
        });
        progress(`run ${runId.slice(0, 8)}: defect filing failed — drafting instead`);
      }
    } else if (autoFileToken && !repo) {
      await store.appendLedger({
        ts: clock(),
        runId,
        agent: agent.name,
        action: "defect-file-skipped",
        type: "defect-report",
        detail: { title: report.title, reason: "config.engine.repo is missing or not owner/name-shaped" },
      });
    } else if (autoFileToken && leaked.length > 0) {
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
      progress(`run ${runId.slice(0, 8)}: defect filing skipped (identity leak) — drafting privately`);
    }

    await store.writeFile(
      rel,
      defectDraftContent({
        title: report.title,
        body: report.body,
        agent: agent.name,
        runId,
        seenAt: clock(),
        leaked: leaked.length > 0 ? leaked : undefined,
      }),
    );
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
  }
  const overflow = reports.slice(MAX_DEFECTS_PER_RUN);
  if (overflow.length > 0) {
    await deny(overflow.map((r) => r.title), `over the ${MAX_DEFECTS_PER_RUN}-defects-per-run cap`);
  }
  return written;
}
