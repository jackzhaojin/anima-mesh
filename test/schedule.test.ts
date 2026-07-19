import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import * as path from "node:path";
import { makeTree, concept } from "./helpers.js";
import { heartbeatCore, PERIOD_HOURS } from "../src/harness/heartbeat-core.js";
import { runAgent } from "../src/harness/run.js";
import { FsInstanceStore } from "../src/instance/store-fs.js";
import { parseScheduleRequest } from "../src/harness/schedule.js";
import { FakeProvider } from "../src/providers/fake.js";
import { registerProvider } from "../src/providers/index.js";
import { Ledger } from "../src/ledger/ledger.js";
import { loadBundle } from "../src/okf/bundle.js";
import { checkConformance } from "../src/okf/conformance.js";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function agentFile(name: string, extra: Record<string, unknown> = {}, body = "Do the job."): string {
  return concept("agent", { name, title: name, level: "L1", model: "test-model", harness: "fake", ...extra }, body);
}

async function makeInstance(extra: Record<string, string> = {}): Promise<string> {
  const files: Record<string, string> = {
    "animamesh.config.json": JSON.stringify({ bundle: "bundle" }, null, 2),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    ...extra,
  };
  const root = await makeTree(files);
  roots.push(root);
  return root;
}

async function readSchedule(root: string): Promise<string> {
  return readFile(path.join(root, "bundle/ops/schedule.md"), "utf8");
}

describe("the schedule surface — wakes, pauses, overrides", () => {
  it("wakes a manual-only agent, consumes the wake in place, and ledgers it", async () => {
    const root = await makeInstance({
      "bundle/agents/helper.md": agentFile("helper"), // no heartbeat: manual-only
      "bundle/ops/schedule.md": concept("schedule", { wake: ["helper"], pause: [] }, "# Schedule\n\nHuman notes survive.\n"),
    });
    const result = await heartbeatCore({ store: new FsInstanceStore(root) });

    expect(result.due).toEqual([{ agent: "helper", reason: "wake requested (ops/schedule.md)" }]);
    expect(result.runs).toHaveLength(1);
    expect(result.ok).toBe(true);

    const after = await readSchedule(root);
    expect(after).toContain("wake: []");
    expect(after).toContain("Human notes survive."); // body preserved through the rewrite

    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).read();
    const consumed = entries.find((e) => e.action === "wake-consumed");
    expect(consumed?.agent).toBe("heartbeat");
    expect(consumed?.detail).toEqual({ agents: ["helper"] });
  });

  it("pause beats wake — the agent is skipped and the contradictory wake stays on file", async () => {
    const root = await makeInstance({
      "bundle/agents/scout.md": agentFile("scout", { heartbeat: "daily" }),
      "bundle/ops/schedule.md": concept("schedule", { wake: ["scout"], pause: ["scout"] }, "# Schedule\n"),
    });
    const result = await heartbeatCore({ store: new FsInstanceStore(root) });

    expect(result.skipped).toContainEqual({ agent: "scout", reason: "paused (ops/schedule.md)" });
    expect(result.runs).toHaveLength(0);
    expect(await readSchedule(root)).toContain('wake: ["scout"]'); // untouched: never attempted
  });

  it("a cadence override changes the due decision (declared daily, effective weekly)", async () => {
    const now = new Date("2026-07-19T12:00:00Z");
    const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const root = await makeInstance({
      "bundle/agents/scout.md": agentFile("scout", { heartbeat: "daily" }),
      "bundle/ops/schedule.md": concept("schedule", { cadence: { scout: "weekly" } }, "# Schedule\n"),
      "ledger/actions.jsonl":
        JSON.stringify({ ts: dayAgo, runId: "r0", agent: "scout", action: "run-completed", type: "report" }) + "\n",
    });
    const result = await heartbeatCore({ store: new FsInstanceStore(root), now, dryRun: true });

    // Declared daily would be due (new calendar day); the weekly override is not.
    expect(result.due).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("weekly: ran 24h ago");
    expect(result.skipped[0]?.reason).toContain("(cadence override)");
  });

  it("keeps a wake the cloud tier cannot honor (laptop-tier harness)", async () => {
    const root = await makeInstance({
      "bundle/agents/local.md": agentFile("local"), // harness "fake" is not in CLOUD_HARNESSES
      "bundle/ops/schedule.md": concept("schedule", { wake: ["local"] }, "# Schedule\n"),
    });
    const result = await heartbeatCore({ store: new FsInstanceStore(root), cloudTier: true });

    expect(result.runs).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("laptop-tier harness");
    expect(await readSchedule(root)).toContain('wake: ["local"]'); // wake survives for the tier that can run it
  });

  it("a wake never bypasses the commercial dual-gate", async () => {
    const root = await makeInstance({
      "bundle/agents/seller.md": agentFile("seller", { commercial: true, heartbeat: "daily" }),
      "bundle/ops/schedule.md": concept("schedule", { wake: ["seller"] }, "# Schedule\n"),
    });
    const result = await heartbeatCore({ store: new FsInstanceStore(root) });

    expect(result.runs).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("dual-gated");
    expect(await readSchedule(root)).toContain('wake: ["seller"]'); // not attempted → not consumed
  });

  it("dry-run reports wake decisions without consuming anything", async () => {
    const root = await makeInstance({
      "bundle/agents/helper.md": agentFile("helper"),
      "bundle/ops/schedule.md": concept("schedule", { wake: ["helper"] }, "# Schedule\n"),
    });
    const result = await heartbeatCore({ store: new FsInstanceStore(root), dryRun: true });

    expect(result.due[0]?.reason).toBe("wake requested (ops/schedule.md)");
    expect(result.runs).toHaveLength(0);
    expect(await readSchedule(root)).toContain('wake: ["helper"]');
  });
});

describe("the schedule-request gate — model proposes, code disposes", () => {
  const REQUEST_REPORT = [
    "## Brief",
    "",
    "helper should follow up tomorrow morning.",
    "",
    "```schedule-request",
    "wake: [helper, hub, ghost]",
    "```",
    "",
  ].join("\n");

  it("applies a request from an L3 agent with schedule-update whitelisted (self and unknown names dropped)", async () => {
    const root = await makeInstance({
      "bundle/agents/hub.md": agentFile("hub", { level: "L3", whitelist: ["schedule-update"], heartbeat: "daily" }),
      "bundle/agents/helper.md": agentFile("helper"),
    });
    const fake = new FakeProvider(() => ({ text: REQUEST_REPORT }));
    const report = await runAgent({ instanceRoot: root, agentName: "hub", provider: fake, runId: "run-sched" });

    expect(report.ok).toBe(true); // conformance verifier saw the new schedule file and stayed green

    const schedule = await readSchedule(root);
    expect(schedule).toContain("- helper");
    expect(schedule).not.toContain("- hub"); // no self-wake loops
    expect(schedule).not.toContain("ghost");

    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-sched");
    const applied = entries.find((e) => e.action === "schedule-updated");
    expect(applied?.detail).toEqual({ wake: ["helper"], dropped: ["hub", "ghost"] });

    // The woken agent actually runs on the next beat.
    const beat = await heartbeatCore({ store: new FsInstanceStore(root), dryRun: true });
    expect(beat.due.map((d) => d.agent)).toContain("helper");
  });

  it("denies the same request from an L1 agent — ledgered, report unaffected, no file created", async () => {
    const root = await makeInstance({
      "bundle/agents/hub.md": agentFile("hub", { heartbeat: "daily" }), // L1, empty whitelist
      "bundle/agents/helper.md": agentFile("helper"),
    });
    const fake = new FakeProvider(() => ({ text: REQUEST_REPORT }));
    const report = await runAgent({ instanceRoot: root, agentName: "hub", provider: fake, runId: "run-denied" });

    expect(report.ok).toBe(true); // a denied request never fails the run itself

    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-denied");
    const denied = entries.find((e) => e.action === "schedule-request-denied");
    expect(denied).toBeDefined();
    expect(String((denied?.detail as { reason?: string }).reason)).toContain("ladder");
    await expect(readSchedule(root)).rejects.toThrow(); // nothing was written
  });

  it("L3 without the whitelist entry is still denied — the whitelist is the gate, not the level", async () => {
    const root = await makeInstance({
      "bundle/agents/hub.md": agentFile("hub", { level: "L3", whitelist: ["other-action"], heartbeat: "daily" }),
      "bundle/agents/helper.md": agentFile("helper"),
    });
    const fake = new FakeProvider(() => ({ text: REQUEST_REPORT }));
    const report = await runAgent({ instanceRoot: root, agentName: "hub", provider: fake, runId: "run-nolist" });

    expect(report.ok).toBe(true);
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-nolist");
    expect(entries.some((e) => e.action === "schedule-request-denied")).toBe(true);
  });
});

describe("wake consumption respects request time", () => {
  it("a wake the hub adds mid-beat for an already-ran spoke survives to the next beat", async () => {
    // Pre-beat: spoke is woken. During the beat the hub (runs last, having
    // read the spoke's fresh report) re-wakes it for tomorrow. Consumption
    // must clear only the PRE-BEAT wake, not the hub's new request.
    registerProvider(
      new FakeProvider(() => ({ text: "## Brief\n\nRetry tomorrow.\n\n```schedule-request\nwake: [spoke]\n```\n" })),
      "fake-hub",
    );
    const root = await makeInstance({
      "bundle/agents/spoke.md": agentFile("spoke"),
      "bundle/agents/chief-of-staff.md": agentFile("chief-of-staff", {
        level: "L3",
        whitelist: ["schedule-update"],
        harness: "fake-hub",
        heartbeat: "daily",
      }),
      "bundle/ops/schedule.md": concept("schedule", { wake: ["spoke"] }, "# Schedule\n"),
    });
    const result = await heartbeatCore({ store: new FsInstanceStore(root) });

    expect(result.runs.map((r) => r.agent)).toEqual(["spoke", "chief-of-staff"]); // hub last
    expect(result.ok).toBe(true);

    const after = await readSchedule(root);
    expect(after).toContain("- spoke"); // the mid-beat re-wake survived consumption

    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).read();
    // Nothing was consumable: the only attempted wake was renewed mid-beat.
    expect(entries.find((e) => e.action === "wake-consumed")).toBeUndefined();
    expect(entries.some((e) => e.action === "schedule-updated")).toBe(true);
  });
});

describe("parseScheduleRequest — tolerant of everything but well-formed asks", () => {
  it("extracts and dedupes wake names", () => {
    expect(parseScheduleRequest("x\n```schedule-request\nwake: [a, b, a]\n```\ny")).toEqual(["a", "b"]);
  });
  it("returns null for absent, malformed, or empty blocks", () => {
    expect(parseScheduleRequest("no block here")).toBeNull();
    expect(parseScheduleRequest("```schedule-request\nwake: [unclosed\n```")).toBeNull();
    expect(parseScheduleRequest("```schedule-request\nwake: []\n```")).toBeNull();
    expect(parseScheduleRequest("```schedule-request\n- just\n- a list\n```")).toBeNull();
  });
});

describe("conformance — the schedule surface is machine-readable or it is an error", () => {
  it("errors on shape violations and bad cadence values; warns on unknown agents", async () => {
    const root = await makeTree({
      "index.md": concept("index", {}, "# Index\n"),
      "log.md": concept("log", {}, "# Log\n"),
      "constitution.md": concept("constitution", { immutable: true }, "# C\n"),
      "agents/scout.md": agentFile("scout", { heartbeat: "daily" }),
      "ops/schedule.md": concept("schedule", { wake: "scout", cadence: { scout: "hourly", ghost: "daily" } }, "# S\n"),
    });
    roots.push(root);
    const report = checkConformance(await loadBundle(root), "animamesh");

    expect(report.ok).toBe(false);
    const rules = report.issues.map((i) => `${i.level}:${i.rule}`);
    expect(rules).toContain("error:animamesh/schedule-shape"); // wake is a string, not an array
    expect(rules).toContain("error:animamesh/schedule-cadence"); // "hourly" is not a cadence
    expect(rules).toContain("warning:animamesh/schedule-unknown-agent"); // ghost isn't in the roster
  });

  it("the due-decision vocabulary and the conformance vocabulary are the same set", () => {
    expect(Object.keys(PERIOD_HOURS).sort()).toEqual(["daily", "monthly", "quarterly", "weekly"]);
  });
});
