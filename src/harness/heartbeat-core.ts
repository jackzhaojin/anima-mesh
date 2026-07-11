import { agentsFromBundle, assertActivatable, type AgentConcept } from "../agents/concept.js";
import { CLOUD_HARNESSES, type ApiProviderContext } from "../providers/index.js";
import type { InstanceStore } from "../instance/store.js";
import { runAgentCore, dateStampFor, type RunReport } from "./run-core.js";

/**
 * The heartbeat trigger — one of D5's four deterministic jobs. Decides which
 * agents are due from their concept's `heartbeat:` cadence and the ledger's
 * last run-completed timestamps, then runs them: spokes first, the
 * chief-of-staff hub last so its brief sees today's fresh reports.
 *
 * Thresholds are slightly under the nominal period so a "daily at 9am-ish"
 * cron drifting by minutes never skips a day.
 *
 * Workers-safe core: the store is required; the filesystem-default wrapper
 * lives in heartbeat.ts.
 */
export const PERIOD_HOURS: Record<string, number> = {
  daily: 20,
  weekly: 6 * 24,
  monthly: 27 * 24,
  quarterly: 85 * 24,
};

export interface HeartbeatCoreOptions {
  store: InstanceStore;
  now?: Date;
  dryRun?: boolean;
  /**
   * Cloud tier: only agents whose harness is in CLOUD_HARNESSES run;
   * subprocess-bound agents are skipped with reason (they surface in the
   * brief as laptop-tier, which is honest reporting, not a bug).
   */
  cloudTier?: boolean;
  /** Env/fetch context for API providers — threaded into every run. */
  providerCtx?: ApiProviderContext;
  /** "per-run" (default) flushes inside each run; "caller" leaves one flush to the caller. */
  flushPolicy?: "per-run" | "caller";
  /**
   * IANA timezone for calendar-day dedup + report datestamps. Default: the
   * runtime's local day. Workers run in UTC and MUST pass the instance
   * timezone or the daily dedup drifts after 8 PM local.
   */
  timeZone?: string;
  onProgress?: (note: string) => void;
}

export interface HeartbeatDecision {
  agent: string;
  reason: string;
}

export interface HeartbeatFailure {
  agent: string;
  error: string;
}

export interface HeartbeatResult {
  due: HeartbeatDecision[];
  skipped: HeartbeatDecision[];
  runs: RunReport[];
  /** Agents whose run threw (provider/auth/etc.) — the beat continues past them. */
  failures: HeartbeatFailure[];
  ok: boolean;
}

/** Calendar day as a comparable yyyymmdd number — tz-aware when given. */
function localDay(epochMs: number, timeZone?: string): number {
  if (timeZone) {
    return Number(dateStampFor(new Date(epochMs), timeZone).replaceAll("-", ""));
  }
  const d = new Date(epochMs);
  return d.getFullYear() * 10_000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export async function heartbeatCore(options: HeartbeatCoreOptions): Promise<HeartbeatResult> {
  const store = options.store;
  const config = await store.loadConfig();
  const bundle = await store.loadBundle();
  const agents = agentsFromBundle(bundle);
  const ledgerEntries = await store.readLedger();
  const now = options.now ?? new Date();
  const progress = options.onProgress ?? (() => {});

  const due: Array<{ agent: AgentConcept; reason: string }> = [];
  const skipped: HeartbeatDecision[] = [];

  for (const agent of agents) {
    if (agent.commercial) {
      try {
        assertActivatable(agent, config);
      } catch {
        skipped.push({ agent: agent.name, reason: "commercial, dual-gated inactive (D11)" });
        continue;
      }
    }
    if (options.cloudTier && !CLOUD_HARNESSES.has(agent.harness)) {
      skipped.push({ agent: agent.name, reason: `laptop-tier harness (${agent.harness}) — not run in cloud` });
      continue;
    }
    if (!agent.heartbeat) {
      skipped.push({ agent: agent.name, reason: "no heartbeat declared (manual runs only)" });
      continue;
    }
    const hours = PERIOD_HOURS[agent.heartbeat];
    if (hours === undefined) {
      skipped.push({ agent: agent.name, reason: `unknown cadence '${agent.heartbeat}'` });
      continue;
    }
    const lastCompleted = ledgerEntries
      .filter((e) => e.agent === agent.name && e.action === "run-completed")
      .map((e) => Date.parse(e.ts))
      .reduce((max, t) => Math.max(max, t), 0);

    if (lastCompleted === 0) {
      due.push({ agent, reason: "never run" });
    } else if (agent.heartbeat === "daily") {
      // Daily means "not yet today" (local calendar), not "20h elapsed" —
      // a late-night manual run must never eat the next morning's brief.
      // (Lesson from the first scheduled morning: 1am debug runs silenced
      // the 8am beat and the principal's daily DM.)
      if (localDay(lastCompleted, options.timeZone) < localDay(now.getTime(), options.timeZone)) {
        due.push({ agent, reason: "daily: not yet run today" });
      } else {
        skipped.push({ agent: agent.name, reason: "daily: already ran today" });
      }
    } else {
      const elapsedHours = (now.getTime() - lastCompleted) / 3_600_000;
      if (elapsedHours >= hours) {
        due.push({ agent, reason: `${agent.heartbeat}: ${Math.floor(elapsedHours)}h since last run` });
      } else {
        skipped.push({
          agent: agent.name,
          reason: `${agent.heartbeat}: ran ${Math.floor(elapsedHours)}h ago (< ${hours}h)`,
        });
      }
    }
  }

  // Spokes alphabetically, the hub last — the brief reads the day's work.
  due.sort((a, b) => {
    const aHub = a.agent.name === "chief-of-staff" ? 1 : 0;
    const bHub = b.agent.name === "chief-of-staff" ? 1 : 0;
    return aHub - bHub || a.agent.name.localeCompare(b.agent.name);
  });

  const dueDecisions: HeartbeatDecision[] = due.map((d) => ({ agent: d.agent.name, reason: d.reason }));
  if (options.dryRun) {
    return { due: dueDecisions, skipped, runs: [], failures: [], ok: true };
  }

  // One spoke's failure never aborts the beat — an unattended mesh must
  // degrade agent-by-agent, not collapse. (Lesson from the first launchd
  // beat: an auth error in one provider killed the remaining runs.)
  const runs: RunReport[] = [];
  const failures: HeartbeatFailure[] = [];
  for (const { agent } of due) {
    progress(`heartbeat: running ${agent.name}`);
    try {
      runs.push(
        await runAgentCore({
          store,
          agentName: agent.name,
          now: options.now,
          providerCtx: options.providerCtx,
          flushPolicy: options.flushPolicy,
          timeZone: options.timeZone,
          onProgress: progress,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ agent: agent.name, error: message });
      progress(`heartbeat: ✗ ${agent.name} failed — ${message.slice(0, 200)} (continuing)`);
    }
  }

  return {
    due: dueDecisions,
    skipped,
    runs,
    failures,
    ok: failures.length === 0 && runs.every((r) => r.ok),
  };
}
