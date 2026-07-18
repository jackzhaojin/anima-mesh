import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SELF, env, fetchMock, runInDurableObject } from "cloudflare:test";
import { mockGitHub, wipeHeartbeatDo } from "./fixtures.js";

/**
 * The HTTP surface, exercised through the deployed-shape Worker in workerd:
 * auth boundaries, sanitization, the public card, and 404-by-default.
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

describe("router", () => {
  it("GET /healthz with no beat history: lastBeat null, alarm armed by bootstrap", async () => {
    const res = await SELF.fetch("https://worker.test/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lastBeat: unknown; nextAlarm: string | null };
    expect(body.lastBeat).toBeNull();
    // Any request first-arms the alarm — /healthz must have armed it.
    expect(body.nextAlarm).not.toBeNull();
    expect(new Date(body.nextAlarm!).getTime()).toBeGreaterThan(Date.now());
  });

  it("first-arm is idempotent: a second request keeps the same alarm", async () => {
    await SELF.fetch("https://worker.test/healthz");
    const first = await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
    await SELF.fetch("https://worker.test/healthz");
    const second = await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
    expect(second).toBe(first);
  });

  it("POST /beat without the Bearer token → 401, wrong token → 401", async () => {
    const bare = await SELF.fetch("https://worker.test/beat", { method: "POST" });
    expect(bare.status).toBe(401);
    const wrong = await SELF.fetch("https://worker.test/beat", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(401);
  });

  it("GET /beat is not a route (POST-only) → 404", async () => {
    const res = await SELF.fetch("https://worker.test/beat");
    expect(res.status).toBe(404);
  });

  it("unknown paths → 404", async () => {
    const res = await SELF.fetch("https://worker.test/reports/latest.md");
    expect(res.status).toBe(404);
  });

  it("/healthz never leaks failure strings — counts and timestamps only", async () => {
    // Seed a worst-case lastBeat: provider error bodies and repo coordinates.
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put("lastBeat", {
        at: "2026-07-11T12:00:00Z",
        kind: "alarm",
        error: "SECRET-TOP-LEVEL github POST /repos/owner/brain → 500",
        summary: {
          date: "2026-07-11",
          due: 2,
          ran: 1,
          skipped: 3,
          failures: [{ agent: "chief-of-staff", error: "SECRET-FAILURE api.kimi.com said no" }],
          commitSha: "b".repeat(40),
          delivered: false,
          deliveryDetail: "SECRET-DELIVERY discord 403",
        },
      });
    });
    const res = await SELF.fetch("https://worker.test/healthz");
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    const body = JSON.parse(text) as { lastBeat: Record<string, unknown> };
    expect(body.lastBeat.ok).toBe(false);
    expect(body.lastBeat.failureCount).toBe(1);
    expect(body.lastBeat.due).toBe(2);
    expect(body.lastBeat.ran).toBe(1);
    expect(body.lastBeat.skipped).toBe(3);
  });

  it("GET /graph/check is bearer-gated like /beat — listing names is instance data", async () => {
    const bare = await SELF.fetch("https://worker.test/graph/check");
    expect(bare.status).toBe(401);
    const wrong = await SELF.fetch("https://worker.test/graph/check", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(401);
  });

  it("GET /graph/check names the missing config instead of erroring opaquely", async () => {
    // This test env deliberately has no MSGRAPH_* bindings — the pre-consent state.
    const res = await SELF.fetch("https://worker.test/graph/check", {
      headers: { authorization: `Bearer ${env.BEAT_TRIGGER_TOKEN}` },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("MSGRAPH_CLIENT_ID");
  });

  it("serves the public agent card from the remote brain, url rewritten to origin", async () => {
    mockGitHub({ flush: false }); // read-only: one snapshot, no commit
    const res = await SELF.fetch("https://worker.test/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    const card = (await res.json()) as {
      capabilities: { streaming: boolean };
      url: string;
      skills: Array<{ id: string }>;
    };
    expect(card.capabilities.streaming).toBe(false); // short-connection by decision
    expect(card.url).toBe("https://worker.test/.well-known/agent-card.json");
    expect(card.skills.map((s) => s.id)).toContain("chief-of-staff");
  });
});
