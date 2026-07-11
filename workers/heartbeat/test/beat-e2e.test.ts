import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SELF, env, fetchMock, runInDurableObject } from "cloudflare:test";
import { mockGitHub, mockKimi, mockDiscord, brainFiles, BASE_SHA, NEW_SHA, wipeHeartbeatDo } from "./fixtures.js";

/**
 * THE end-to-end proof, entirely local: a Bearer-authorized beat through the
 * deployed-shape Worker in workerd — GitHub snapshot → due decision → Kimi
 * cognition → report + ledger composed → ONE commit → Discord DM — with
 * every seam asserted from the scripted services' captured requests. This is
 * the same pipeline production runs at 08:00 ET, minus the network.
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

describe("full cloud beat, end to end in workerd", () => {
  it("runs the due agent on Kimi, lands ONE commit, DMs the brief", async () => {
    const gh = mockGitHub();
    const kimi = mockKimi("# Daily brief\n\nAll quiet on the test front.");
    const discord = mockDiscord();

    const res = await SELF.fetch("https://worker.test/beat", {
      method: "POST",
      headers: { authorization: `Bearer ${env.BEAT_TRIGGER_TOKEN}` },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      kind: string;
      summary: {
        due: number;
        ran: number;
        skipped: number;
        failures: unknown[];
        commitSha?: string;
        delivered: boolean;
      };
    };

    // The summary: one cloud-capable agent due and run; the laptop-tier
    // librarian skipped with reason — honest reporting, not a bug.
    expect(body.kind).toBe("manual");
    expect(body.summary.due).toBe(1);
    expect(body.summary.ran).toBe(1);
    expect(body.summary.failures).toEqual([]);
    expect(body.summary.skipped).toBeGreaterThanOrEqual(1); // librarian (claude-code)
    expect(body.summary.commitSha).toBe(NEW_SHA);
    expect(body.summary.delivered).toBe(true);

    // Cognition went to Kimi with the harness-assembled prompt (bundle
    // context, never recall) and the agent's pinned model.
    expect(kimi.requests).toHaveLength(1);
    expect(kimi.requests[0]!.model).toBe("kimi-for-coding");
    const userMsg = kimi.requests[0]!.messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("annual return"); // ops/calendar.md inlined
    expect(userMsg.content).toContain("chief-of-staff");

    // ONE commit: report + ledger in the same tree, parented on the
    // snapshot sha, authored by the cloud identity, force:false.
    expect(gh.trees).toHaveLength(1);
    const paths = gh.trees[0]!.tree.map((t) => t.path).sort();
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe("ledger/actions.jsonl");
    expect(paths[1]).toMatch(/^reports\/\d{4}-\d{2}-\d{2}-chief-of-staff-[0-9a-f]{8}\.md$/);

    const ledger = gh.trees[0]!.tree.find((t) => t.path === "ledger/actions.jsonl")!;
    const lines = ledger.content.trim().split("\n");
    expect(lines).toHaveLength(4); // 1 fixture line + started/written/completed
    expect(lines.slice(1).map((l) => (JSON.parse(l) as { action: string }).action)).toEqual([
      "run-started",
      "report-written",
      "run-completed",
    ]);

    const report = gh.trees[0]!.tree.find((t) => t.path !== "ledger/actions.jsonl")!;
    expect(report.content).toContain("type: report");
    expect(report.content).toContain("All quiet on the test front.");

    expect(gh.commits).toHaveLength(1);
    expect(gh.commits[0]!.message).toMatch(/^beat\(cloud\): \d{4}-\d{2}-\d{2} — 1 run\(s\), 0 failure\(s\)$/);
    expect(gh.commits[0]!.parents).toEqual([BASE_SHA]);
    expect(gh.commits[0]!.author.name).toBe("animamesh-cloud");

    expect(gh.patches).toHaveLength(1);
    expect(gh.patches[0]!.force).toBe(false);
    expect(gh.patches[0]!.sha).toBe(NEW_SHA);

    // The brief reached Discord as a bot DM to the configured principal.
    expect(discord.dmOpens).toEqual([{ recipient_id: "42" }]);
    expect(discord.messages).toHaveLength(1);
    expect(discord.messages[0]!.content).toContain("Daily brief");
  });

  it("beat against a brain that already ran today: dedup skips honestly, no commit", async () => {
    // The brain's ledger holds today's completed run — exactly what the repo
    // looks like the moment after a successful beat (calendar-day dedup).
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: env.BEAT_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const files = brainFiles();
    files["ledger/actions.jsonl"] =
      JSON.stringify({ ts: `${today}T12:00:00.000Z`, runId: "r1", agent: "chief-of-staff", action: "run-completed", type: "report" }) + "\n";
    const gh = mockGitHub({ files, flush: false }); // no cognition, no commit, no delivery

    const res = await SELF.fetch("https://worker.test/beat", {
      method: "POST",
      headers: { authorization: `Bearer ${env.BEAT_TRIGGER_TOKEN}` },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { summary: { due: number; ran: number; commitSha?: string } };
    expect(body.summary.due).toBe(0);
    expect(body.summary.ran).toBe(0);
    expect(body.summary.commitSha).toBeUndefined(); // nothing dirty → no commit
    expect(gh.trees).toHaveLength(0);
  });

  it("a failing provider fails that agent, the beat completes and reports it", async () => {
    // The run-started ledger line still flushes (evidence of the attempt);
    // an agent-level failure is NOT a beat-level crash, so no failure DM.
    const gh = mockGitHub();
    // Kimi hard-fails (400: not retryable — no backoff stall).
    fetchMock
      .get("https://fake-kimi.test")
      .intercept({ method: "POST", path: "/v1/chat/completions" })
      .reply(400, "model rejects request");

    const res = await SELF.fetch("https://worker.test/beat", {
      method: "POST",
      headers: { authorization: `Bearer ${env.BEAT_TRIGGER_TOKEN}` },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      summary: { due: number; ran: number; failures: Array<{ agent: string; error: string }>; delivered: boolean };
    };
    expect(body.summary.due).toBe(1);
    expect(body.summary.ran).toBe(0);
    expect(body.summary.failures).toHaveLength(1);
    expect(body.summary.failures[0]!.agent).toBe("chief-of-staff");
    expect(body.summary.failures[0]!.error).toMatch(/400/);
    // Nothing ran → nothing to deliver; the beat still completed cleanly.
    expect(body.summary.delivered).toBe(false);
    // The attempt is still evidence: run-started flushed to the ledger.
    expect(gh.trees).toHaveLength(1);
    expect(gh.trees[0]!.tree.map((t) => t.path)).toEqual(["ledger/actions.jsonl"]);
  });
});
