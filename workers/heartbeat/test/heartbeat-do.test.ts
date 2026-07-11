import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SELF, env, fetchMock, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { mockGitHub, mockGitHubDown, mockKimi, mockDiscord, wipeHeartbeatDo } from "./fixtures.js";

/**
 * The Durable Object's safety properties, in real workerd: the alarm that
 * always re-arms (even when the beat crashes), the beat mutex, and honest
 * lastBeat records. These are the guarantees CLOUDFLARE.md promises.
 */

beforeEach(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  await wipeHeartbeatDo();
});

const stub = () => env.HEARTBEAT_DO.get(env.HEARTBEAT_DO.idFromName("main"));

afterEach(() => {
  fetchMock.assertNoPendingInterceptors(); // the mock plan IS the expected traffic
  fetchMock.deactivate();
});

async function getAlarm(): Promise<number | null> {
  return runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
}

/** Hour-of-day of an epoch in the configured beat timezone. */
function hourInTz(epochMs: number, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hour12: false }).format(new Date(epochMs)),
  );
}

describe("HeartbeatDO alarm", () => {
  it("arms at the configured hour in the configured timezone, in the future", async () => {
    await SELF.fetch("https://worker.test/healthz"); // bootstrap arm
    const alarm = await getAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThan(Date.now());
    expect(hourInTz(alarm!, env.BEAT_TIMEZONE)).toBe(Number(env.BEAT_HOUR));
  });

  it("re-arms in finally even when the beat crashes — a dead beat never silences tomorrow", async () => {
    mockGitHubDown(); // beat will fail at the store stage
    const discord = mockDiscord(); // failure DM goes out

    await SELF.fetch("https://worker.test/healthz"); // arm
    const armed = await getAlarm();
    expect(armed).not.toBeNull();

    const ran = await runDurableObjectAlarm(stub());
    expect(ran).toBe(true);

    // The crash was recorded, the failure DM attempted, and the alarm re-armed.
    const rearmed = await getAlarm();
    expect(rearmed).not.toBeNull();
    expect(hourInTz(rearmed!, env.BEAT_TIMEZONE)).toBe(Number(env.BEAT_HOUR));

    const last = await runInDurableObject(stub(), (_i, state) =>
      state.storage.get<{ kind: string; error?: string }>("lastBeat"),
    );
    expect(last?.kind).toBe("alarm");
    expect(last?.error).toMatch(/500/);

    expect(discord.messages).toHaveLength(1);
    expect(discord.messages[0]!.content).toContain("cloud beat failed");
  });

  it("a completed alarm beat re-arms for a future fire", async () => {
    mockGitHub();
    mockKimi();
    mockDiscord();
    await SELF.fetch("https://worker.test/healthz"); // arm
    await runDurableObjectAlarm(stub());
    const rearmed = await getAlarm();
    expect(rearmed).not.toBeNull();
    expect(rearmed!).toBeGreaterThan(Date.now());
  });
});

describe("HeartbeatDO mutex", () => {
  it("a fresh lock makes a manual trigger skip instead of double-running", async () => {
    await runInDurableObject(stub(), async (_i, state) => {
      await state.storage.put("beat-running", Date.now());
    });
    const res = await SELF.fetch("https://worker.test/beat", {
      method: "POST",
      headers: { authorization: `Bearer ${env.BEAT_TRIGGER_TOKEN}` },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { skipped?: string };
    expect(body.skipped).toMatch(/already running/);
  });

  it("a stale lock (>30 min) is stolen and the beat proceeds; the lock clears after", async () => {
    mockGitHub();
    mockKimi();
    mockDiscord();
    await runInDurableObject(stub(), async (_i, state) => {
      await state.storage.put("beat-running", Date.now() - 31 * 60 * 1000);
    });
    const res = await SELF.fetch("https://worker.test/beat", {
      method: "POST",
      headers: { authorization: `Bearer ${env.BEAT_TRIGGER_TOKEN}` },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { summary?: { ran: number } };
    expect(body.summary?.ran).toBe(1);

    const lock = await runInDurableObject(stub(), (_i, state) => state.storage.get("beat-running"));
    expect(lock).toBeUndefined();
  });
});
