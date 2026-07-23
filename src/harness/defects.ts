import type { InstanceStore } from "../instance/store.js";
import type { InstanceConfig } from "../instance/config-core.js";
import { assertActionAllowed, GateViolation } from "../gates/gatekeeper.js";
import type { ApprovalRecord } from "../gates/approvals.js";
import type { Level } from "../autonomy/ladder.js";
import { githubToken } from "../instance/github-auth.js";
import { getEnv } from "../instance/env-core.js";
import {
  parseDefectReports,
  engineRepoSlug,
  identityLeakGuard,
  createDefectIssue,
  MAX_DEFECTS_PER_RUN,
  MAX_DEFECT_BYTES,
} from "../defects/report-core.js";

/**
 * Apply `defect-report` blocks from a run's output: parse → gate (level +
 * whitelist, one decision for the batch) → per-report identity-leak guard →
 * file on `config.engine.repo` → ledger. Same propose/dispose contract as
 * drafts.ts; see defects/report-core.ts for the block format and rationale.
 *
 * Credential order: `GITHUB_DEFECTS_TOKEN` (fine-grained PAT, Issues R/W on
 * the engine repo — the recommended, smallest-blast-radius credential),
 * else the instance's `githubToken` (App/PAT — only works if that identity
 * carries Issues:write on the ENGINE repo, which the brain-repo App usually
 * does not). No credential ⇒ honest ledgered denial, never a crash.
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

/** Issue URLs actually filed this run (deduped filings included). */
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
  // reversible action. A denial ledgers ALL requested titles and files none.
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

  const repo = engineRepoSlug(config);
  if (!repo) {
    await deny(reports.map((r) => r.title), "config.engine.repo is missing or not owner/name-shaped");
    return [];
  }

  let token = getEnv(options.env, "GITHUB_DEFECTS_TOKEN");
  if (!token) {
    try {
      token = await githubToken(options.env, options.fetchImpl ?? fetch);
    } catch {
      token = undefined;
    }
  }
  if (!token) {
    await deny(
      reports.map((r) => r.title),
      "no GitHub credential with Issues:write — set GITHUB_DEFECTS_TOKEN (fine-grained PAT, Issues R/W on the engine repo)",
    );
    return [];
  }

  const filed: string[] = [];
  for (const report of reports.slice(0, MAX_DEFECTS_PER_RUN)) {
    const leaked = identityLeakGuard(`${report.title}\n${report.body}`, config);
    if (leaked.length > 0) {
      await deny([report.title], `identity leak — the engine repo is public and the report contains: ${leaked.join(", ")}`);
      continue;
    }
    if (report.body.length > MAX_DEFECT_BYTES) {
      await deny([report.title], `body exceeds ${MAX_DEFECT_BYTES} bytes`);
      continue;
    }
    try {
      const issue = await createDefectIssue({
        repo,
        title: report.title,
        body: report.body,
        token,
        fetchImpl: options.fetchImpl,
      });
      await store.appendLedger({
        ts: clock(),
        runId,
        agent: agent.name,
        action: "defect-reported",
        type: "defect-report",
        detail: { title: report.title, url: issue.url, number: issue.number, duplicate: issue.duplicate },
      });
      progress(
        `run ${runId.slice(0, 8)}: defect ${issue.duplicate ? "already filed" : "filed"} — ${issue.url}`,
      );
      filed.push(issue.url);
    } catch (err) {
      await deny([report.title], err instanceof Error ? err.message : String(err));
    }
  }
  const overflow = reports.slice(MAX_DEFECTS_PER_RUN);
  if (overflow.length > 0) {
    await deny(overflow.map((r) => r.title), `over the ${MAX_DEFECTS_PER_RUN}-defects-per-run cap`);
  }
  return filed;
}
