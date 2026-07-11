import { DurableObject } from "cloudflare:workers";
import { GitHubInstanceStore } from "../../../src/instance/store-github.js";
import { githubToken } from "../../../src/instance/github-auth.js";
import { runDirectionCore, type DirectionMessage } from "../../../src/harness/direction-core.js";
import { dateStampFor } from "../../../src/harness/run-core.js";
import { envRecord, type Env } from "./env.js";

/**
 * DirectionDO — the queue-and-think half of the direction pipeline. The
 * interactions route (3-second budget) only verifies, gates, and enqueues;
 * this DO's alarm does the slow part: run the persona agentically over the
 * GitHub-hosted brain, land ONE commit per drain, and reply through the
 * interaction followup webhook (tokens are valid 15 minutes — plenty).
 *
 * Its own DO class because a Durable Object holds exactly one alarm and
 * HeartbeatDO's belongs to the daily beat. State: the queue, the per-ET-day
 * budget counter (decision Q4, cap via DIRECTION_DAILY_CAP, default 20),
 * and the denied-sender log (decision Q5) — folded into the ledger on the
 * next drain, never a commit per knock.
 */

const QUEUE_KEY = "queue";
const DENIED_KEY = "denied";
const DENIED_MAX = 50;
const RETRY_DELAY_MS = 60_000;
export const DEFAULT_DAILY_CAP = 20;

export interface QueuedDirection {
  message: DirectionMessage;
  followup?: { applicationId: string; token: string };
}

export interface DeniedRecord {
  channel: string;
  sender: string;
  receivedAt: string;
}

export class DirectionDO extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/enqueue" && req.method === "POST") {
      const item = (await req.json()) as QueuedDirection;
      const cap = Number(this.env.DIRECTION_DAILY_CAP ?? DEFAULT_DAILY_CAP);
      const day = dateStampFor(new Date(), this.env.BEAT_TIMEZONE);
      const countKey = `count:${day}`;
      const count = (await this.ctx.storage.get<number>(countKey)) ?? 0;
      if (count >= cap) {
        return Response.json({ status: "budget", cap }, { status: 429 });
      }
      await this.ctx.storage.put(countKey, count + 1);
      const queue = (await this.ctx.storage.get<QueuedDirection[]>(QUEUE_KEY)) ?? [];
      queue.push(item);
      await this.ctx.storage.put(QUEUE_KEY, queue);
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now());
      }
      return Response.json({ status: "queued", position: queue.length }, { status: 202 });
    }

    if (url.pathname === "/denied" && req.method === "POST") {
      const record = (await req.json()) as DeniedRecord;
      const denied = (await this.ctx.storage.get<DeniedRecord[]>(DENIED_KEY)) ?? [];
      denied.push(record);
      await this.ctx.storage.put(DENIED_KEY, denied.slice(-DENIED_MAX));
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/stats" && req.method === "GET") {
      const day = dateStampFor(new Date(), this.env.BEAT_TIMEZONE);
      return Response.json({
        today: (await this.ctx.storage.get<number>(`count:${day}`)) ?? 0,
        cap: Number(this.env.DIRECTION_DAILY_CAP ?? DEFAULT_DAILY_CAP),
        queued: ((await this.ctx.storage.get<QueuedDirection[]>(QUEUE_KEY)) ?? []).length,
        deniedPending: ((await this.ctx.storage.get<DeniedRecord[]>(DENIED_KEY)) ?? []).length,
      });
    }

    return new Response("not found", { status: 404 });
  }

  override async alarm(): Promise<void> {
    // Snapshot-and-clear first: a re-entrant alarm must never double-process.
    const queue = (await this.ctx.storage.get<QueuedDirection[]>(QUEUE_KEY)) ?? [];
    const denied = (await this.ctx.storage.get<DeniedRecord[]>(DENIED_KEY)) ?? [];
    await this.ctx.storage.delete(QUEUE_KEY);
    await this.ctx.storage.delete(DENIED_KEY);
    if (queue.length === 0 && denied.length === 0) return;

    try {
      await this.drain(queue, denied);
    } catch (err) {
      // Evidence didn't land (flush failed after the runs, or the store
      // died). Requeue everything and retry shortly; direction replies are
      // only sent after their evidence commits.
      console.log(`direction drain failed: ${err instanceof Error ? err.message : String(err)}`);
      const requeued = (await this.ctx.storage.get<QueuedDirection[]>(QUEUE_KEY)) ?? [];
      await this.ctx.storage.put(QUEUE_KEY, [...queue, ...requeued]);
      const deniedNow = (await this.ctx.storage.get<DeniedRecord[]>(DENIED_KEY)) ?? [];
      await this.ctx.storage.put(DENIED_KEY, [...denied, ...deniedNow].slice(-DENIED_MAX));
      await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
    }
  }

  private async drain(queue: QueuedDirection[], denied: DeniedRecord[]): Promise<void> {
    const env = this.env;
    const record = envRecord(env);
    const store = new GitHubInstanceStore({
      repo: env.BRAIN_REPO,
      ref: env.BRAIN_REF,
      token: await githubToken(record),
    });

    // Q5's audit trail rides the same commit as the day's directions.
    for (const d of denied) {
      await store.appendLedger({
        ts: d.receivedAt,
        runId: crypto.randomUUID(),
        agent: "channel-edge",
        action: "direction-denied",
        type: "report",
        detail: { channel: d.channel, sender: d.sender },
      });
    }

    const followups: Array<{ followup?: QueuedDirection["followup"]; content: string }> = [];
    for (const item of queue) {
      try {
        const report = await runDirectionCore({
          store,
          message: item.message,
          providerCtx: { env: record },
          flushPolicy: "caller", // one commit per drain, not per direction
          timeZone: env.BEAT_TIMEZONE,
          onProgress: console.log,
        });
        followups.push({ followup: item.followup, content: report.reply });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`direction failed: ${message}`);
        followups.push({
          followup: item.followup,
          content: `⚠️ I couldn't process that direction (${message.slice(0, 200)}). It's logged; try again or wait for the next brief.`,
        });
      }
    }

    await store.flush(
      `direction: ${queue.length} processed${denied.length ? `, ${denied.length} denied recorded` : ""}`,
    );

    // Replies go out only after the evidence landed.
    for (const f of followups) {
      if (!f.followup) continue;
      try {
        const res = await fetch(
          `https://discord.com/api/v10/webhooks/${f.followup.applicationId}/${f.followup.token}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: f.content }),
          },
        );
        if (!res.ok) console.log(`direction followup → HTTP ${res.status}`);
      } catch (err) {
        console.log(`direction followup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
