import { DurableObject } from "cloudflare:workers";
import { runCloudBeat, type BeatSummary } from "./beat.js";
import { nextBeatUtc } from "./alarm-time.js";
import type { Env } from "./env.js";
import { envRecord } from "./env.js";
import { createMsGraphTokenManager, type MsGraphCredential } from "../../../src/sources/msgraph-auth.js";

const BEAT_LOCK_KEY = "beat-running";
const LAST_BEAT_KEY = "lastBeat";
const MANUAL_PENDING_KEY = "manual-pending";
const PROGRESS_KEY = "beat-progress";
/** An in-flight beat older than this is presumed hung and may be stolen. */
const STALE_LOCK_MS = 30 * 60 * 1000;

export interface LastBeat {
  at: string;
  kind: "alarm" | "manual";
  summary?: BeatSummary;
  error?: string;
}

/**
 * Persisted for the duration of a beat. Outliving its isolate (deploy
 * eviction, crash) is how a stranded beat is recognized: the storage record
 * survives, the in-memory promise does not. Locks written before v0.9.2
 * were a bare epoch number — tolerated on read.
 */
interface BeatLock {
  startedAt: number;
  kind: "alarm" | "manual";
}

/**
 * One singleton DO: holds the daily alarm (DST-correct via nextBeatUtc) and
 * the beat mutex so a manual trigger during the alarm can't double-run.
 * Alarms survive deploys; re-arming is idempotent; the alarm ALWAYS re-arms
 * in finally — a crashed beat must not silence tomorrow.
 *
 * A manual /trigger persists a request and schedules an immediate alarm
 * before acknowledging it. The alarm awaits the beat, independent of the
 * HTTP client. The pending request survives isolate loss and is consumed
 * only after an outcome is stored. Platform alarm retries can resume it.
 * Execution is at least once; an interruption after external side effects
 * can replay them, as with the daily alarm.
 */
export class HeartbeatDO extends DurableObject<Env> {
  /**
   * Non-null exactly while a beat runs in THIS isolate. A storage lock with
   * no in-flight promise means the isolate that took it is gone. Input gates
   * make the check-then-set around it atomic: the gate stays closed across
   * storage awaits and only opens once the beat awaits external I/O.
   */
  private beatInFlight: Promise<LastBeat> | null = null;
  private graphToken: (() => Promise<string>) | undefined;

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/msgraph-token" && req.method === "POST") {
      this.graphToken ??= createMsGraphTokenManager({ env: envRecord(this.env) }, {
        load: () => this.ctx.storage.get<MsGraphCredential>("msgraph-credential"),
        save: (value) => this.ctx.storage.put("msgraph-credential", value),
      });
      try {
        return Response.json({ token: await this.graphToken() });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "msgraph credential refresh failed" }, { status: 502 });
      }
    }

    if (url.pathname === "/ensure-alarm") {
      const existing = await this.ctx.storage.getAlarm();
      const pending = await this.ctx.storage.get(MANUAL_PENDING_KEY);
      if (existing === null || (pending !== undefined && !this.beatInFlight && existing < Date.now() - 60_000)) {
        // A persisted request must not remain stranded behind an old alarm
        // timestamp after runtime loss. Never replace an active run's alarm.
        await this.rearm();
      }
      return Response.json({ nextAlarm: new Date((await this.ctx.storage.getAlarm())!).toISOString() });
    }

    if (url.pathname === "/status") {
      await this.reconcileStrandedLock();
      const lastBeat = (await this.ctx.storage.get<LastBeat>(LAST_BEAT_KEY)) ?? null;
      const alarm = await this.ctx.storage.getAlarm();
      // This feeds the UNAUTHENTICATED /healthz: counts and timestamps ONLY.
      // Failure/error strings can carry repo coordinates and provider error
      // bodies — they stay in DO storage, the token-gated /beat response,
      // and wrangler tail.
      const sanitized = lastBeat
        ? {
            at: lastBeat.at,
            kind: lastBeat.kind,
            ok: !lastBeat.error && (lastBeat.summary?.failures.length ?? 0) === 0,
            date: lastBeat.summary?.date,
            due: lastBeat.summary?.due,
            ran: lastBeat.summary?.ran,
            skipped: lastBeat.summary?.skipped,
            failureCount: lastBeat.error ? 1 : (lastBeat.summary?.failures.length ?? 0),
            delivered: lastBeat.summary?.delivered ?? false,
            commitSha: lastBeat.summary?.commitSha,
            tokens: lastBeat.summary?.tokens,
          }
        : null;
      return Response.json({
        lastBeat: sanitized,
        beatRunning: this.beatInFlight !== null,
        beatQueued: (await this.ctx.storage.get(MANUAL_PENDING_KEY)) !== undefined,
        progress: (await this.ctx.storage.get(PROGRESS_KEY)) ?? null,
        nextAlarm: alarm === null ? null : new Date(alarm).toISOString(),
      });
    }

    if (url.pathname === "/trigger" && req.method === "POST") {
      if (this.beatInFlight) {
        return Response.json({ skipped: "beat already running" }, { status: 202 });
      }
      await this.reconcileStrandedLock();
      const pending = await this.ctx.storage.get<string>(MANUAL_PENDING_KEY);
      if (pending) {
        return Response.json({ skipped: "beat already queued", started: pending }, { status: 202 });
      }
      const started = new Date().toISOString();
      // Queue and alarm commit together: a 202 must never acknowledge work
      // held only in an isolate, or leave it waiting for tomorrow's alarm.
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put(MANUAL_PENDING_KEY, started);
        await txn.setAlarm(Date.now() + 1000);
      });
      return Response.json({ started, kind: "manual", queued: true }, { status: 202 });
    }

    return new Response("not found", { status: 404 });
  }

  override async alarm(): Promise<void> {
    try {
      const pending = await this.ctx.storage.get<string>(MANUAL_PENDING_KEY);
      const begun = await this.beginBeat(pending ? "manual" : "alarm");
      if ("promise" in begun) {
        await begun.promise;
        if (pending) await this.ctx.storage.delete(MANUAL_PENDING_KEY);
      }
    } finally {
      await this.rearm();
    }
  }

  private async rearm(): Promise<void> {
    const pending = await this.ctx.storage.get(MANUAL_PENDING_KEY);
    const next = pending !== undefined
      ? new Date(Date.now() + 1000)
      : nextBeatUtc(new Date(), this.env.BEAT_TIMEZONE, Number(this.env.BEAT_HOUR));
    await this.ctx.storage.setAlarm(next);
  }

  private async beginBeat(
    kind: "alarm" | "manual",
  ): Promise<{ skipped: string } | { started: string; promise: Promise<LastBeat> }> {
    const lock = await this.ctx.storage.get<BeatLock | number>(BEAT_LOCK_KEY);
    if (lock !== undefined) {
      const startedAt = typeof lock === "number" ? lock : lock.startedAt;
      if (this.beatInFlight) {
        if (Date.now() - startedAt < STALE_LOCK_MS) {
          return { skipped: `beat already running (lock ${new Date(startedAt).toISOString()})` };
        }
        // In-flight but past the stale threshold: presumed hung; steal.
      } else {
        await this.journalInterrupted(lock);
      }
    }
    await this.ctx.storage.put(BEAT_LOCK_KEY, { startedAt: Date.now(), kind } satisfies BeatLock);
    const promise = this.executeBeat(kind);
    this.beatInFlight = promise;
    return { started: new Date().toISOString(), promise };
  }

  /**
   * A lock with no in-flight beat is a beat that died with its isolate
   * (deploy eviction, crash). Record it as an honest failed lastBeat so
   * /healthz stops serving the previous run as current truth, and reclaim
   * the lock immediately.
   */
  private async journalInterrupted(lock: BeatLock | number): Promise<void> {
    const startedAt = typeof lock === "number" ? lock : lock.startedAt;
    const kind = typeof lock === "number" ? "manual" : lock.kind;
    const interrupted: LastBeat = {
      at: new Date(startedAt).toISOString(),
      kind,
      error: "beat interrupted mid-run (isolate evicted or crashed, likely a deploy); lock reconciled",
    };
    const prev = await this.ctx.storage.get<LastBeat>(LAST_BEAT_KEY);
    if (!prev || prev.at < interrupted.at) {
      await this.ctx.storage.put(LAST_BEAT_KEY, interrupted);
    }
    await this.ctx.storage.delete(BEAT_LOCK_KEY);
  }

  private async reconcileStrandedLock(): Promise<void> {
    if (this.beatInFlight) return;
    const lock = await this.ctx.storage.get<BeatLock | number>(BEAT_LOCK_KEY);
    if (lock !== undefined) {
      await this.journalInterrupted(lock);
    }
  }

  /**
   * Never rejects — the outcome, success or failure, IS the LastBeat record.
   * runCloudBeat attempts its own failure DM before rethrowing.
   */
  private async executeBeat(kind: "alarm" | "manual"): Promise<LastBeat> {
    let last: LastBeat;
    try {
      await this.ctx.storage.put(PROGRESS_KEY, { at: new Date().toISOString(), stage: "init" });
      const summary = await runCloudBeat(this.env, (note) => {
        console.log(note);
        // Categories only: health is public. Never persist provider error
        // text, agent names, paths, source content, or credentials here.
        const stage = note.startsWith("heartbeat: running ") ? "agent-start"
          : note.includes(" via ") && note.startsWith("run ") ? "model-start"
          : note.includes("requested read(s) served") ? "read-continuation"
          : note.includes(" retry ") ? "provider-retry"
          : note.includes("output budget reached") ? "output-continuation"
          : note.startsWith("beat stage: ") ? note.slice("beat stage: ".length) : undefined;
        if (stage) this.ctx.waitUntil(this.ctx.storage.put(PROGRESS_KEY, { at: new Date().toISOString(), stage }));
      });
      await this.ctx.storage.put(PROGRESS_KEY, { at: new Date().toISOString(), stage: "complete" });
      last = { at: new Date().toISOString(), kind, summary };
    } catch (err) {
      last = {
        at: new Date().toISOString(),
        kind,
        error: err instanceof Error ? err.message : String(err),
      };
      console.log(`${kind} beat failed: ${last.error}`);
    }
    try {
      await this.ctx.storage.put(LAST_BEAT_KEY, last);
    } finally {
      this.beatInFlight = null;
      await this.ctx.storage.delete(BEAT_LOCK_KEY);
    }
    return last;
  }
}
