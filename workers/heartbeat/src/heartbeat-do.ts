import { DurableObject } from "cloudflare:workers";
import { runCloudBeat, type BeatSummary } from "./beat.js";
import { nextBeatUtc } from "./alarm-time.js";
import type { Env } from "./env.js";

const BEAT_LOCK_KEY = "beat-running";
const LAST_BEAT_KEY = "lastBeat";
/** A lock older than this is presumed crashed and may be stolen. */
const STALE_LOCK_MS = 30 * 60 * 1000;

export interface LastBeat {
  at: string;
  kind: "alarm" | "manual";
  summary?: BeatSummary;
  error?: string;
}

/**
 * One singleton DO: holds the daily alarm (DST-correct via nextBeatUtc) and
 * the beat mutex so a manual trigger during the alarm can't double-run.
 * Alarms survive deploys; re-arming is idempotent; the alarm ALWAYS re-arms
 * in finally — a crashed beat must not silence tomorrow.
 */
export class HeartbeatDO extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/ensure-alarm") {
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null) {
        await this.rearm();
      }
      return Response.json({ nextAlarm: new Date((await this.ctx.storage.getAlarm())!).toISOString() });
    }

    if (url.pathname === "/status") {
      const lastBeat = (await this.ctx.storage.get<LastBeat>(LAST_BEAT_KEY)) ?? null;
      const alarm = await this.ctx.storage.getAlarm();
      return Response.json({
        lastBeat,
        nextAlarm: alarm === null ? null : new Date(alarm).toISOString(),
      });
    }

    if (url.pathname === "/trigger" && req.method === "POST") {
      const result = await this.runBeat("manual");
      return Response.json(result, { status: 202 });
    }

    return new Response("not found", { status: 404 });
  }

  override async alarm(): Promise<void> {
    try {
      await this.runBeat("alarm");
    } catch (err) {
      // The beat already attempted its failure DM; don't rethrow — a platform
      // retry storm helps nobody, and tomorrow's alarm is re-armed below.
      console.log(`alarm beat failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await this.rearm();
    }
  }

  private async rearm(): Promise<void> {
    const next = nextBeatUtc(new Date(), this.env.BEAT_TIMEZONE, Number(this.env.BEAT_HOUR));
    await this.ctx.storage.setAlarm(next);
  }

  private async runBeat(kind: "alarm" | "manual"): Promise<LastBeat | { skipped: string }> {
    const lock = await this.ctx.storage.get<number>(BEAT_LOCK_KEY);
    if (lock && Date.now() - lock < STALE_LOCK_MS) {
      return { skipped: `beat already running (lock ${new Date(lock).toISOString()})` };
    }
    await this.ctx.storage.put(BEAT_LOCK_KEY, Date.now());
    try {
      const summary = await runCloudBeat(this.env);
      const last: LastBeat = { at: new Date().toISOString(), kind, summary };
      await this.ctx.storage.put(LAST_BEAT_KEY, last);
      return last;
    } catch (err) {
      const last: LastBeat = {
        at: new Date().toISOString(),
        kind,
        error: err instanceof Error ? err.message : String(err),
      };
      await this.ctx.storage.put(LAST_BEAT_KEY, last);
      throw err;
    } finally {
      await this.ctx.storage.delete(BEAT_LOCK_KEY);
    }
  }
}
