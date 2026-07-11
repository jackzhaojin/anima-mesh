import { DurableObject } from "cloudflare:workers";
import { GitHubInstanceStore } from "../../../src/instance/store-github.js";
import { githubToken } from "../../../src/instance/github-auth.js";
import { runDirectionCore, type DirectionMessage } from "../../../src/harness/direction-core.js";
import { dateStampFor } from "../../../src/harness/run-core.js";
import { gmailChannel, pollGmailInbox, markGmailRead } from "../../../src/channels/gmail.js";
import { envRecord, type Env } from "./env.js";

/**
 * DirectionDO — the queue-and-think half of the direction pipeline. The
 * interactions route (3-second budget) only verifies, gates, and enqueues;
 * this DO's alarm does the slow part: run the persona agentically over the
 * GitHub-hosted brain, land ONE commit per drain, and reply on the
 * originating channel — Discord interaction followup (15-min token) or a
 * reply email.
 *
 * Its own DO class because a Durable Object holds exactly one alarm and
 * HeartbeatDO's belongs to the daily beat. The one alarm here serves both
 * jobs: immediate drains (armed by enqueue) and the Gmail poll cadence
 * (decision Q3b — DIRECTION_GMAIL_POLL_MINUTES, re-armed in finally).
 *
 * State: the queue, the per-ET-day budget counter (Q4, DIRECTION_DAILY_CAP,
 * default 20 — Discord AND Gmail directions share it), the denied-sender
 * log (Q5 — folded into the ledger on the next drain, never a commit per
 * knock), and the processed-Gmail-id ring (dedup even if mark-read fails).
 */

const QUEUE_KEY = "queue";
const DENIED_KEY = "denied";
const GMAIL_SEEN_KEY = "gmail-processed";
const DENIED_MAX = 50;
const GMAIL_SEEN_MAX = 100;
const RETRY_DELAY_MS = 60_000;
export const DEFAULT_DAILY_CAP = 20;

export interface QueuedDirection {
  message: DirectionMessage;
  /** Discord: reply via the interaction webhook. */
  followup?: { applicationId: string; token: string };
  /** Gmail: reply by mail + mark read after the evidence lands. */
  email?: { id: string; from: string; subject: string };
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
      if (!(await this.consumeBudget())) {
        return Response.json({ status: "budget", cap: this.cap() }, { status: 429 });
      }
      const queue = (await this.ctx.storage.get<QueuedDirection[]>(QUEUE_KEY)) ?? [];
      queue.push(item);
      await this.ctx.storage.put(QUEUE_KEY, queue);
      // Overwrite any later alarm (a poll slot must not delay a direction);
      // the finally-rearm restores the poll cadence after the drain.
      await this.ctx.storage.setAlarm(Date.now());
      return Response.json({ status: "queued", position: queue.length }, { status: 202 });
    }

    if (url.pathname === "/denied" && req.method === "POST") {
      const record = (await req.json()) as DeniedRecord;
      const denied = (await this.ctx.storage.get<DeniedRecord[]>(DENIED_KEY)) ?? [];
      denied.push(record);
      await this.ctx.storage.put(DENIED_KEY, denied.slice(-DENIED_MAX));
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/ensure-poll" && req.method === "POST") {
      const pollMs = this.pollMinutes() * 60_000;
      if (pollMs > 0 && (await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + pollMs);
      }
      const alarm = await this.ctx.storage.getAlarm();
      return Response.json({ nextAlarm: alarm === null ? null : new Date(alarm).toISOString() });
    }

    if (url.pathname === "/poll" && req.method === "POST") {
      // Manual poke + the deterministic test seam: one full cycle now.
      const summary = await this.processAll();
      await this.rearmPoll();
      return Response.json(summary);
    }

    if (url.pathname === "/stats" && req.method === "GET") {
      const day = dateStampFor(new Date(), this.env.BEAT_TIMEZONE);
      return Response.json({
        today: (await this.ctx.storage.get<number>(`count:${day}`)) ?? 0,
        cap: this.cap(),
        queued: ((await this.ctx.storage.get<QueuedDirection[]>(QUEUE_KEY)) ?? []).length,
        deniedPending: ((await this.ctx.storage.get<DeniedRecord[]>(DENIED_KEY)) ?? []).length,
      });
    }

    return new Response("not found", { status: 404 });
  }

  override async alarm(): Promise<void> {
    try {
      await this.processAll();
    } catch (err) {
      console.log(`direction alarm failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await this.rearmPoll();
    }
  }

  // ---- budget (Q4) ----------------------------------------------------------

  private cap(): number {
    return Number(this.env.DIRECTION_DAILY_CAP ?? DEFAULT_DAILY_CAP);
  }

  private pollMinutes(): number {
    return Number(this.env.DIRECTION_GMAIL_POLL_MINUTES ?? 0);
  }

  private async consumeBudget(): Promise<boolean> {
    const day = dateStampFor(new Date(), this.env.BEAT_TIMEZONE);
    const key = `count:${day}`;
    const count = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (count >= this.cap()) return false;
    await this.ctx.storage.put(key, count + 1);
    return true;
  }

  private async rearmPoll(): Promise<void> {
    const pollMs = this.pollMinutes() * 60_000;
    if (pollMs > 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + pollMs);
    }
  }

  // ---- the work -------------------------------------------------------------

  /** One full cycle: poll Gmail (when enabled) + drain the queue + fold denials. */
  private async processAll(): Promise<{ processed: number; budgetSkipped: number; denied: number }> {
    const record = envRecord(this.env);

    // Inbound email (Q3b/Q6): unread from the allowlisted sender only.
    let budgetSkipped = 0;
    const allowedFrom = this.env.DIRECTION_GMAIL_ALLOWED_FROM ?? "";
    if (this.pollMinutes() > 0 && allowedFrom) {
      try {
        const seen = (await this.ctx.storage.get<string[]>(GMAIL_SEEN_KEY)) ?? [];
        const seenSet = new Set(seen);
        const emails = (await pollGmailInbox({ env: record }, { allowedFrom })).filter((e) => !seenSet.has(e.id));
        const queue = (await this.ctx.storage.get<QueuedDirection[]>(QUEUE_KEY)) ?? [];
        for (const e of emails) {
          if (!(await this.consumeBudget())) {
            budgetSkipped++; // stays unread and unseen — eligible again tomorrow
            continue;
          }
          queue.push({
            message: {
              channel: "gmail",
              sender: e.from,
              text: `Subject: ${e.subject}\n\n${e.text}`,
              receivedAt: e.receivedAt,
              messageId: e.id,
            },
            email: e,
          });
          seen.push(e.id); // in the queue now — later polls must skip it even if mark-read fails
        }
        await this.ctx.storage.put(QUEUE_KEY, queue);
        await this.ctx.storage.put(GMAIL_SEEN_KEY, seen.slice(-GMAIL_SEEN_MAX));
      } catch (err) {
        console.log(`gmail poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Snapshot-and-clear: a re-entrant alarm must never double-process.
    const queue = (await this.ctx.storage.get<QueuedDirection[]>(QUEUE_KEY)) ?? [];
    const denied = (await this.ctx.storage.get<DeniedRecord[]>(DENIED_KEY)) ?? [];
    await this.ctx.storage.delete(QUEUE_KEY);
    await this.ctx.storage.delete(DENIED_KEY);
    if (queue.length === 0 && denied.length === 0) {
      return { processed: 0, budgetSkipped, denied: 0 };
    }

    try {
      await this.drain(queue, denied, record);
      return { processed: queue.length, budgetSkipped, denied: denied.length };
    } catch (err) {
      // Evidence didn't land (store/flush died). Requeue and retry shortly —
      // replies only ever follow committed evidence.
      console.log(`direction drain failed: ${err instanceof Error ? err.message : String(err)}`);
      const requeued = (await this.ctx.storage.get<QueuedDirection[]>(QUEUE_KEY)) ?? [];
      await this.ctx.storage.put(QUEUE_KEY, [...queue, ...requeued]);
      const deniedNow = (await this.ctx.storage.get<DeniedRecord[]>(DENIED_KEY)) ?? [];
      await this.ctx.storage.put(DENIED_KEY, [...denied, ...deniedNow].slice(-DENIED_MAX));
      await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
      return { processed: 0, budgetSkipped, denied: 0 };
    }
  }

  private async drain(
    queue: QueuedDirection[],
    denied: DeniedRecord[],
    record: Record<string, string | undefined>,
  ): Promise<void> {
    const env = this.env;
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

    const replies: Array<{ item: QueuedDirection; content: string }> = [];
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
        replies.push({ item, content: report.reply });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`direction failed: ${message}`);
        replies.push({
          item,
          content: `⚠️ I couldn't process that direction (${message.slice(0, 200)}). It's logged; try again or wait for the next brief.`,
        });
      }
    }

    const persona = (await store.loadConfig()).identity?.persona?.name;
    await store.flush(
      `direction: ${queue.length} processed${denied.length ? `, ${denied.length} denied recorded` : ""}`,
    );

    // Replies go out only after the evidence landed.
    for (const { item, content } of replies) {
      try {
        if (item.followup) {
          const res = await fetch(
            `https://discord.com/api/v10/webhooks/${item.followup.applicationId}/${item.followup.token}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ content }),
            },
          );
          if (!res.ok) console.log(`direction followup → HTTP ${res.status}`);
        } else if (item.email) {
          await gmailChannel.deliver(
            {
              title: item.email.subject ? `Re: ${item.email.subject}` : "Re: your direction",
              body: content,
              recipient: item.email.from,
              ...(persona ? { sender: persona } : {}),
            },
            { env: record },
          );
          await markGmailRead({ env: record }, item.email.id);
        }
      } catch (err) {
        console.log(`direction reply failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
