import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import * as path from "node:path";
import { makeTree, concept } from "./helpers.js";
import { runDirectionCore, type DirectionMessage } from "../src/harness/direction-core.js";
import { heartbeat } from "../src/harness/heartbeat.js";
import { FsInstanceStore } from "../src/instance/store-fs.js";
import { deliverLatestReportFromStore } from "../src/channels/registry.js";
import { FakeProvider } from "../src/providers/fake.js";
import { registerProvider } from "../src/providers/index.js";
import { ActivationGateError } from "../src/agents/concept.js";

/**
 * Direction — the second entry point. These prove the contract from
 * direction-core's header: agentic disposition with full context, evidence
 * in the repo, and the two deliberate differences from beat runs (ledger
 * actions that can't eat the daily dedup; artifact names that brief
 * delivery skips).
 */

const roots: string[] = [];
afterEach(async () => {
  registerProvider(new FakeProvider(), "fake");
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

const NOW = new Date("2026-07-11T16:00:00Z");
const TZ = "America/New_York";

const MESSAGE: DirectionMessage = {
  channel: "discord",
  sender: "principal-42",
  text: "What's the status of the annual return? Anything you need from me?",
  receivedAt: NOW.toISOString(),
  messageId: "interaction-1",
};

async function makeInstance(extra: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const root = await makeTree({
    "animamesh.config.json": JSON.stringify({ bundle: "bundle", ...config }),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/ops/calendar.md": concept("calendar", {}, "# Calendar\n\n- 2026-09-15: annual return due\n"),
    "bundle/agents/chief-of-staff.md": concept(
      "agent",
      { name: "chief-of-staff", title: "Chief of Staff", level: "L1", model: "test-model", harness: "fake", heartbeat: "daily" },
      "Coordinate the mesh; answer the principal.",
    ),
    "ledger/actions.jsonl": "",
    ...extra,
  });
  roots.push(root);
  return root;
}

describe("runDirectionCore — an inbound message becomes one agentic run", () => {
  it("writes the evidence artifact, the direction ledger trio, and returns the reply", async () => {
    const root = await makeInstance();
    const fake = new FakeProvider(() => ({ text: "On track — due 2026-09-15. Nothing needed from you yet." }));

    const report = await runDirectionCore({
      store: new FsInstanceStore(root),
      message: MESSAGE,
      provider: fake,
      now: NOW,
      timeZone: TZ,
      runId: "d1000000-0000-0000-0000-000000000000",
    });

    expect(report.ok).toBe(true);
    expect(report.agent).toBe("chief-of-staff");
    expect(report.reply).toContain("due 2026-09-15");
    for (const v of report.verifierResults) expect(v.ok).toBe(true);

    // The artifact: dot before "direction" (delivery-matcher-blind), both
    // the inbound text and the disposition recorded.
    expect(report.reportPath.endsWith("2026-07-11-chief-of-staff.direction-d1000000.md")).toBe(true);
    const artifact = await readFile(report.reportPath, "utf8");
    expect(artifact).toContain("trigger: direction");
    expect(artifact).toContain("channel: discord");
    expect(artifact).toContain("sender: principal-42");
    expect(artifact).toContain("status of the annual return"); // the inbound message
    expect(artifact).toContain("Nothing needed from you yet."); // the disposition

    // Ledger: direction-* trio with channel/sender detail, frozen clock.
    const lines = (await readFile(path.join(root, "ledger/actions.jsonl"), "utf8")).trim().split("\n");
    const entries = lines.map((l) => JSON.parse(l) as { action: string; ts: string; detail?: Record<string, unknown> });
    expect(entries.map((e) => e.action)).toEqual([
      "direction-started",
      "direction-report-written",
      "direction-completed",
    ]);
    expect(entries[0]!.detail).toMatchObject({ channel: "discord", sender: "principal-42", messageId: "interaction-1" });
    expect(new Set(entries.map((e) => e.ts))).toEqual(new Set([NOW.toISOString()]));

    // The model saw the message AND the bundle context (never recall).
    const prompt = fake.calls[0]!.prompt;
    expect(prompt).toContain("annual return due"); // calendar inlined
    expect(prompt).toContain("Anything you need from me?"); // the direction
    expect(prompt).toContain("cannot take actions directly"); // C6 in the prompt
  });

  it("a direction today does NOT eat the daily beat — dedup keys on run-completed only", async () => {
    const root = await makeInstance();
    registerProvider(new FakeProvider(() => ({ text: "answered" })), "fake");

    await runDirectionCore({ store: new FsInstanceStore(root), message: MESSAGE, now: NOW, timeZone: TZ });

    const result = await heartbeat({ instanceRoot: root, now: NOW, timeZone: TZ, dryRun: true });
    expect(result.due.map((d) => d.agent)).toEqual(["chief-of-staff"]);
    expect(result.due[0]!.reason).toBe("never run"); // direction-* is invisible to beat dedup
  });

  it("brief delivery never picks a direction artifact as 'the latest brief'", async () => {
    const root = await makeInstance({
      "reports/2026-07-10-chief-of-staff-beat0000.md": "---\ntype: report\n---\n\n# Real brief\n\nthe beat brief\n",
    });
    const store = new FsInstanceStore(root);
    registerProvider(new FakeProvider(() => ({ text: "direction reply" })), "fake");
    await runDirectionCore({ store, message: MESSAGE, now: NOW, timeZone: TZ });

    const results = await deliverLatestReportFromStore(store, { channels: ["console"], env: {} });
    expect(results[0]!.ok).toBe(true);
    // Delivered the beat brief, not today's (lexicographically later) direction artifact.
    const delivered: string[] = [];
    await deliverLatestReportFromStore(store, { channels: ["console"], env: {}, log: (n) => delivered.push(n) });
    expect(delivered.join("\n")).toContain("the beat brief");
    expect(delivered.join("\n")).not.toContain("direction reply");
  });

  it("agent resolution: direction.agent > delivery.deliverAgent > chief-of-staff", async () => {
    const extra = {
      "bundle/agents/ops.md": concept(
        "agent",
        { name: "ops", title: "Ops", level: "L1", model: "m", harness: "fake" },
        "Handle operational directions.",
      ),
    };
    const root = await makeInstance(extra, { direction: { agent: "ops" } });
    registerProvider(new FakeProvider(() => ({ text: "ok" })), "fake");
    const report = await runDirectionCore({ store: new FsInstanceStore(root), message: MESSAGE, now: NOW });
    expect(report.agent).toBe("ops");

    const root2 = await makeInstance(extra, { delivery: { deliverAgent: "ops" } });
    const report2 = await runDirectionCore({ store: new FsInstanceStore(root2), message: MESSAGE, now: NOW });
    expect(report2.agent).toBe("ops");
  });

  it("replies are capped for the channel (1900 chars)", async () => {
    const root = await makeInstance();
    const report = await runDirectionCore({
      store: new FsInstanceStore(root),
      message: MESSAGE,
      provider: new FakeProvider(() => ({ text: "x".repeat(5000) })),
      now: NOW,
    });
    expect(report.reply).toHaveLength(1900);
  });

  it("keeps the safety model: commercial agents refuse directions without the dual gate", async () => {
    const root = await makeInstance(
      {
        "bundle/agents/closer.md": concept(
          "agent",
          { name: "closer", title: "Closer", level: "L1", model: "m", harness: "fake", commercial: true },
          "Qualify leads.",
        ),
      },
      { direction: { agent: "closer" } },
    );
    await expect(
      runDirectionCore({ store: new FsInstanceStore(root), message: MESSAGE, provider: new FakeProvider() }),
    ).rejects.toThrow(ActivationGateError);
  });

  it("fails loud on unknown direction agents", async () => {
    const root = await makeInstance({}, { direction: { agent: "ghost" } });
    await expect(
      runDirectionCore({ store: new FsInstanceStore(root), message: MESSAGE, provider: new FakeProvider() }),
    ).rejects.toThrow(/agent 'ghost' not found/);
  });
});
