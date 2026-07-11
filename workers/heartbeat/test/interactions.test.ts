import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SELF, env, fetchMock, runInDurableObject } from "cloudflare:test";
import {
  mockGitHub,
  mockKimi,
  mockDiscordFollowup,
  signedInteraction,
  principalCommand,
  wipeHeartbeatDo,
} from "./fixtures.js";

/**
 * The direction pipeline in real workerd: Ed25519 at the door, the sender
 * gate (Q5), the budget (Q4), and the full deferred flow — enqueue → the
 * DirectionDO alarm thinks on fake Kimi → ONE commit of evidence → the
 * reply lands on the interaction followup webhook.
 */

beforeEach(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  await wipeHeartbeatDo();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors(); // the mock plan IS the expected traffic
  fetchMock.deactivate();
});

const directionStub = () => env.DIRECTION_DO.get(env.DIRECTION_DO.idFromName("main"));

async function send(payload: unknown): Promise<Response> {
  const req = await signedInteraction(payload);
  return SELF.fetch("https://worker.test/interactions", {
    method: "POST",
    headers: Object.fromEntries(req.headers.entries()),
    body: await req.text(),
  });
}

/**
 * Enqueue arms an immediate alarm and REAL workerd fires it in the
 * background — the pipeline runs itself. Tests observe convergence (the
 * followup landing) instead of forcing the alarm, or they race the drain.
 */
async function waitForFollowups(script: { contents: string[] }, n = 1): Promise<void> {
  await vi.waitFor(
    () => {
      if (script.contents.length < n) throw new Error(`followups: ${script.contents.length}/${n}`);
    },
    { timeout: 5_000, interval: 20 },
  );
}

describe("the door: signature and handshake", () => {
  it("answers Discord's PING with PONG when correctly signed", async () => {
    const res = await send({ type: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("rejects a bad signature with 401 — nothing past the door", async () => {
    const body = JSON.stringify({ type: 1 });
    const res = await SELF.fetch("https://worker.test/interactions", {
      method: "POST",
      headers: {
        "x-signature-ed25519": "ab".repeat(64),
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("rejects unsigned requests with 401", async () => {
    const res = await SELF.fetch("https://worker.test/interactions", {
      method: "POST",
      body: JSON.stringify({ type: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("the sender gate (Q5)", () => {
  it("a stranger's command gets NO interaction response; the attempt is recorded", async () => {
    const res = await send(principalCommand("do my bidding", "999"));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");

    const denied = await runInDurableObject(directionStub(), (_i, state) =>
      state.storage.get<Array<{ sender: string }>>("denied"),
    );
    expect(denied).toHaveLength(1);
    expect(denied![0]!.sender).toBe("999");
  });

  it("recorded denials fold into the ledger on the next drain — one commit, no commit-per-knock", async () => {
    await send(principalCommand("sneaky", "999"));
    // A denial alone arms nothing IMMEDIATE — the only alarm is the far-off
    // Gmail poll slot (the router bootstrap arms it on every request); the
    // denial's audit rides the next direction's drain.
    const alarmAfterDenial = await runInDurableObject(directionStub(), (_i, state) => state.storage.getAlarm());
    expect(alarmAfterDenial).not.toBeNull();
    expect(alarmAfterDenial!).toBeGreaterThan(Date.now() + 10 * 60_000);

    const gh = mockGitHub();
    mockKimi("Understood — handled.");
    const followup = mockDiscordFollowup();
    await send(principalCommand("status?"));
    await waitForFollowups(followup);

    expect(gh.trees).toHaveLength(1);
    const ledger = gh.trees[0]!.tree.find((t) => t.path === "ledger/actions.jsonl")!;
    expect(ledger.content).toContain('"action":"direction-denied"');
    expect(ledger.content).toContain('"sender":"999"');
    expect(followup.contents).toEqual(["Understood — handled."]);
  });
});

describe("the budget gate (Q4, test cap = 3)", () => {
  it("directions over the daily cap get an ephemeral budget reply, not cognition", async () => {
    // Mock 3 full drains — the immediate alarm processes each as it lands.
    const followup = mockDiscordFollowup(3);
    for (let i = 0; i < 3; i++) {
      mockGitHub();
      mockKimi(`answer ${i}`);
      const res = await send(principalCommand(`direction number ${i}`));
      expect(((await res.json()) as { type: number }).type).toBe(5);
      await waitForFollowups(followup, i + 1);
    }

    const fourth = await send(principalCommand("one too many"));
    const body = (await fourth.json()) as { type: number; data: { content: string; flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("budget reached");
    expect(body.data.flags).toBe(64); // ephemeral

    // The counter holds at the cap; the over-budget one spent no cognition.
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: env.BEAT_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const count = await runInDurableObject(directionStub(), (_i, state) =>
      state.storage.get<number>(`count:${today}`),
    );
    expect(count).toBe(3);
  });

  it("an empty message is answered immediately, costs nothing", async () => {
    const res = await send({ ...(principalCommand("x") as object), data: { name: "direct", options: [] } });
    const body = (await res.json()) as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("Nothing to act on");
  });
});

describe("the full deferred flow", () => {
  it("defer → DirectionDO thinks on Kimi → ONE commit of evidence → followup reply", async () => {
    const gh = mockGitHub();
    const kimi = mockKimi("On track — annual return due 2026-09-15; nothing needed from you.");
    const followup = mockDiscordFollowup();

    const res = await send(principalCommand("What's the status of the annual return?"));
    expect(((await res.json()) as { type: number }).type).toBe(5); // deferred within the 3s window

    // The immediate alarm drains in the background; observe convergence.
    await waitForFollowups(followup);

    // Cognition saw the direction with bundle context.
    expect(kimi.requests).toHaveLength(1);
    const prompt = kimi.requests[0]!.messages.find((m) => m.role === "user")!.content;
    expect(prompt).toContain("What's the status of the annual return?");
    expect(prompt).toContain("annual return"); // calendar inlined
    expect(prompt).toContain("cannot take actions directly");

    // ONE commit: the .direction- artifact + the direction ledger trio.
    expect(gh.trees).toHaveLength(1);
    const paths = gh.trees[0]!.tree.map((t) => t.path).sort();
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe("ledger/actions.jsonl");
    expect(paths[1]).toMatch(/^reports\/\d{4}-\d{2}-\d{2}-chief-of-staff\.direction-[0-9a-f]{8}\.md$/);
    const ledger = gh.trees[0]!.tree.find((t) => t.path === "ledger/actions.jsonl")!;
    for (const action of ["direction-started", "direction-report-written", "direction-completed"]) {
      expect(ledger.content).toContain(`"action":"${action}"`);
    }
    expect(gh.commits[0]!.message).toBe("direction: 1 processed");

    // The reply reached Discord only after the evidence landed.
    expect(followup.contents).toEqual(["On track — annual return due 2026-09-15; nothing needed from you."]);

    // Queue drained.
    const queue = await runInDurableObject(directionStub(), (_i, state) => state.storage.get<unknown[]>("queue"));
    expect(queue ?? []).toHaveLength(0);
  });

  it("a failing direction run still answers the principal honestly", async () => {
    const gh = mockGitHub();
    fetchMock
      .get("https://fake-kimi.test")
      .intercept({ method: "POST", path: "/v1/chat/completions" })
      .reply(400, "model rejects request");
    const followup = mockDiscordFollowup();

    await send(principalCommand("please think about this"));
    await waitForFollowups(followup);

    expect(followup.contents[0]).toContain("couldn't process");
    // The attempt is still evidence: direction-started flushed.
    expect(gh.trees).toHaveLength(1);
    expect(gh.trees[0]!.tree.map((t) => t.path)).toEqual(["ledger/actions.jsonl"]);
  });
});
