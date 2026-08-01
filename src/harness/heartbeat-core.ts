import { agentsFromBundle, assertActivatable, effectiveCognition, type AgentConcept } from "../agents/concept.js";
import { CLOUD_HARNESSES, type ApiProviderContext } from "../providers/index.js";
import type { InstanceStore } from "../instance/store.js";
import type { LedgerEntry } from "../ledger/ledger.js";
import { runAgentCore, dateStampFor, type RunReport } from "./run-core.js";
import { scheduleFromBundle, effectiveCadence, mutateSchedule, type Schedule } from "./schedule.js";
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
  /**
   * DUE agents this tier could not run (laptop-tier harness on a cloud
   * beat). Also present in `skipped`; broken out because a due agent that
   * silently skips is indistinguishable from a quiet day — the hub's prompt
   * gets these as beat notes so the principal hears "run this locally".
   */
  tierBlocked: HeartbeatDecision[];
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

/**
 * Would this agent run right now (wake or cadence)? One vocabulary for both
 * callers: the run decision itself, and the cloud tier's due-but-unrunnable
 * accounting. Pause is checked by the caller — its precedence differs by
 * branch (pause beats wake everywhere, but a paused laptop-tier agent must
 * not read as "blocked", just as paused).
 */
function dueVerdict(
  agent: AgentConcept,
  schedule: Schedule,
  ledgerEntries: LedgerEntry[],
  now: Date,
  timeZone?: string,
): { due: boolean; reason: string } {
  if (schedule.wake.includes(agent.name)) {
    // One-shot wake: due regardless of cadence — even agents with no
    // heartbeat at all can be woken on demand. Consumed after the attempt.
    return { due: true, reason: "wake requested (ops/schedule.md)" };
  }
  const cadence = effectiveCadence(agent, schedule);
  const overridden = agent.name in schedule.cadence ? " (cadence override)" : "";
  if (!cadence) return { due: false, reason: "no heartbeat declared (manual runs only)" };
  const hours = PERIOD_HOURS[cadence];
  if (hours === undefined) return { due: false, reason: `unknown cadence '${cadence}'${overridden}` };
  const lastCompleted = ledgerEntries
    .filter((e) => e.agent === agent.name && e.action === "run-completed")
    .map((e) => Date.parse(e.ts))
    .reduce((max, t) => Math.max(max, t), 0);

  if (lastCompleted === 0) return { due: true, reason: "never run" };
  if (cadence === "daily") {
    // Daily means "not yet today" (local calendar), not "20h elapsed" —
    // a late-night manual run must never eat the next morning's brief.
    // (Lesson from the first scheduled morning: 1am debug runs silenced
    // the 8am beat and the principal's daily DM.)
    return localDay(lastCompleted, timeZone) < localDay(now.getTime(), timeZone)
      ? { due: true, reason: `daily: not yet run today${overridden}` }
      : { due: false, reason: `daily: already ran today${overridden}` };
  }
  const elapsedHours = (now.getTime() - lastCompleted) / 3_600_000;
  return elapsedHours >= hours
    ? { due: true, reason: `${cadence}: ${Math.floor(elapsedHours)}h since last run${overridden}` }
    : { due: false, reason: `${cadence}: ran ${Math.floor(elapsedHours)}h ago (< ${hours}h)${overridden}` };
}

/**
 * Stated to the hub's own prompt, not just logged: the brief is the only
 * surface the principal reads, so a scheduler fact that never reaches a
 * prompt effectively never happened (the lesson of issues #4 and #5,
 * applied to the scheduler itself).
 */
function tierBlockedNotes(blocked: HeartbeatDecision[]): string[] {
  return [
    "## Scheduler notes for this beat (surface these in your brief)",
    "This beat runs on the cloud tier. The agents below were DUE this beat but could not run",
    "here — their harness exists only on the laptop tier. No report from them exists today,",
    "and nothing else will tell the principal. Treat each as an active nag in your brief until",
    "the principal either runs the agent locally (`pnpm cli run <agent> --instance <path>` on",
    "the laptop) or changes its harness or cadence:",
    ...blocked.map((b) => `- ${b.agent} — ${b.reason}`),
  ];
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
  const tierBlocked: HeartbeatDecision[] = [];

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
      // belongs to whichever tier can honor it, not to this beat. But when
      // the agent is DUE, the skip must not be silent: the hub is told
      // (beat notes) so the brief nags "run this locally" instead of
      // letting a missing report read as a quiet day.
      const verdict = schedule.pause.includes(agent.name)
        ? { due: false, reason: "paused" }
        : dueVerdict(agent, schedule, ledgerEntries, now, options.timeZone);
      if (verdict.due) {
        const reason = `DUE (${verdict.reason}) but laptop-tier harness (${cognition.harness}) — needs a manual local run`;
        tierBlocked.push({ agent: agent.name, reason });
        skipped.push({ agent: agent.name, reason });
      } else {
        skipped.push({ agent: agent.name, reason: `laptop-tier harness (${cognition.harness}) — not run in cloud` });
      }
      continue;
    }
    if (schedule.pause.includes(agent.name)) {
      // Pause beats wake: an explicit stop outranks an explicit go, and a
      // contradictory wake stays visible in the file instead of vanishing.
      skipped.push({ agent: agent.name, reason: "paused (ops/schedule.md)" });
      continue;
    }
    const verdict = dueVerdict(agent, schedule, ledgerEntries, now, options.timeZone);
    if (verdict.due) due.push({ agent, reason: verdict.reason });
    else skipped.push({ agent: agent.name, reason: verdict.reason });
  }

  // Spokes alphabetically, the hub last — the brief reads the day's work.
  due.sort((a, b) => {
    const aHub = a.agent.name === "chief-of-staff" ? 1 : 0;
    const bHub = b.agent.name === "chief-of-staff" ? 1 : 0;
    return aHub - bHub || a.agent.name.localeCompare(b.agent.name);
  });

  const dueDecisions: HeartbeatDecision[] = due.map((d) => ({ agent: d.agent.name, reason: d.reason }));
  if (options.dryRun) {
    return { due: dueDecisions, skipped, tierBlocked, runs: [], failures: [], ok: true };
  }

  // One spoke's failure never aborts the beat — an unattended mesh must
  // degrade agent-by-agent, not collapse. (Lesson from the first launchd
  // beat: an auth error in one provider killed the remaining runs.)
  const hubName = config.delivery?.deliverAgent ?? "chief-of-staff";
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
          // The hub speaks for the beat: due-but-unrunnable agents ride into
          // its prompt so the brief can nag the principal to run them locally.
          beatNotes: agent.name === hubName && tierBlocked.length > 0 ? tierBlockedNotes(tierBlocked) : undefined,
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
  // A wake RENEWED during the beat survives: the hub runs last and may
  // re-wake a spoke that already ran, having just read its report — that is
  // a request about the NEXT beat. The ledger's schedule-updated entries
  // appended during this beat are the record of such renewals.
  const renewed = new Set(
    (await store.readLedger())
      .slice(ledgerEntries.length)
      .filter((e) => e.action === "schedule-updated")
      .flatMap((e) => {
        const wake = (e.detail as { wake?: unknown } | undefined)?.wake;
        return Array.isArray(wake) ? wake.filter((x): x is string => typeof x === "string") : [];
      }),
  );
  const attempted = new Set(due.map((d) => d.agent.name));
  const consumable = (n: string) => attempted.has(n) && !renewed.has(n);
  const consumed = schedule.wake.filter(consumable);
  if (consumed.length > 0) {
    await mutateSchedule(store, config, (s) => ({ ...s, wake: s.wake.filter((n) => !consumable(n)) }));
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
    tierBlocked,
    runs,
    failures,
    ok: failures.length === 0 && runs.every((r) => r.ok),
  };
}
