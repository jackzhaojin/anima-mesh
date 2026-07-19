import { agentsFromBundle, assertActivatable, effectiveCognition, type AgentConcept } from "../agents/concept.js";
import { CLOUD_HARNESSES, type ApiProviderContext } from "../providers/index.js";
import type { InstanceStore } from "../instance/store.js";
import { runAgentCore, dateStampFor, type RunReport } from "./run-core.js";
import { scheduleFromBundle, effectiveCadence, mutateSchedule } from "./schedule.js";
import type { SourceFs } from "../sources/types.js";

/**
 * The heartbeat trigger — one of D5's four deterministic jobs. Decides which
 * agents are due from their concept's `heartbeat:` cadence (as overridden by
 * the optional `ops/schedule.md` surface — pauses, cadence overrides, and
 * one-shot wakes) and the ledger's last run-completed timestamps, then runs
 * them: spokes first, the chief-of-staff hub last so its brief sees today's
 * fresh reports. Scheduling stays deterministic: code reads files; the only
 * model influence on WHO runs is a schedule edit that passed its gate.
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
  /** Local-read capability for sources — threaded into every run; Node tier only. */
  sourceFs?: SourceFs;
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

  const schedule = scheduleFromBundle(bundle);
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
    const cognition = effectiveCognition(agent, config);
    if (options.cloudTier && !CLOUD_HARNESSES.has(cognition.harness)) {
      // A pending wake for a laptop-tier agent is deliberately KEPT — it
      // belongs to whichever tier can honor it, not to this beat.
      skipped.push({ agent: agent.name, reason: `laptop-tier harness (${cognition.harness}) — not run in cloud` });
      continue;
    }
    if (schedule.pause.includes(agent.name)) {
      // Pause beats wake: an explicit stop outranks an explicit go, and a
      // contradictory wake stays visible in the file instead of vanishing.
      skipped.push({ agent: agent.name, reason: "paused (ops/schedule.md)" });
      continue;
    }
    if (schedule.wake.includes(agent.name)) {
      // One-shot wake: due regardless of cadence — even agents with no
      // heartbeat at all can be woken on demand. Consumed after the attempt.
      due.push({ agent, reason: "wake requested (ops/schedule.md)" });
      continue;
    }
    const cadence = effectiveCadence(agent, schedule);
    const overridden = agent.name in schedule.cadence ? " (cadence override)" : "";
    if (!cadence) {
      skipped.push({ agent: agent.name, reason: "no heartbeat declared (manual runs only)" });
      continue;
    }
    const hours = PERIOD_HOURS[cadence];
    if (hours === undefined) {
      skipped.push({ agent: agent.name, reason: `unknown cadence '${cadence}'${overridden}` });
      continue;
    }
    const lastCompleted = ledgerEntries
      .filter((e) => e.agent === agent.name && e.action === "run-completed")
      .map((e) => Date.parse(e.ts))
      .reduce((max, t) => Math.max(max, t), 0);

    if (lastCompleted === 0) {
      due.push({ agent, reason: "never run" });
    } else if (cadence === "daily") {
      // Daily means "not yet today" (local calendar), not "20h elapsed" —
      // a late-night manual run must never eat the next morning's brief.
      // (Lesson from the first scheduled morning: 1am debug runs silenced
      // the 8am beat and the principal's daily DM.)
      if (localDay(lastCompleted, options.timeZone) < localDay(now.getTime(), options.timeZone)) {
        due.push({ agent, reason: `daily: not yet run today${overridden}` });
      } else {
        skipped.push({ agent: agent.name, reason: `daily: already ran today${overridden}` });
      }
    } else {
      const elapsedHours = (now.getTime() - lastCompleted) / 3_600_000;
      if (elapsedHours >= hours) {
        due.push({ agent, reason: `${cadence}: ${Math.floor(elapsedHours)}h since last run${overridden}` });
      } else {
        skipped.push({
          agent: agent.name,
          reason: `${cadence}: ran ${Math.floor(elapsedHours)}h ago (< ${hours}h)${overridden}`,
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
          sourceFs: options.sourceFs,
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

  // One-shot wakes are consumed on ATTEMPT, not on success: a sticky wake
  // retrying a broken agent would beat-spam the vendor forever. The failure
  // DM tells the principal, who can re-wake deliberately. Wakes the tier or
  // gates could not honor were never attempted and stay on file.
  const attempted = new Set(due.map((d) => d.agent.name));
  const consumed = schedule.wake.filter((n) => attempted.has(n));
  if (consumed.length > 0) {
    await mutateSchedule(store, config, (s) => ({ ...s, wake: s.wake.filter((n) => !attempted.has(n)) }));
    await store.appendLedger({
      ts: now.toISOString(),
      runId: crypto.randomUUID(),
      agent: "heartbeat",
      action: "wake-consumed",
      type: "schedule",
      detail: { agents: consumed },
    });
    progress(`heartbeat: wake consumed for ${consumed.join(", ")}`);
    if ((options.flushPolicy ?? "per-run") === "per-run") {
      await store.flush(`beat: wake consumed (${consumed.join(", ")})`);
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
