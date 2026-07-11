import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { makeTree, concept } from "./helpers.js";
import { heartbeat } from "../src/harness/heartbeat.js";
import { FakeProvider } from "../src/providers/fake.js";
import { registerProvider } from "../src/providers/index.js";

/**
 * The golden day — P2's testing bar: one fully scripted mesh day replayed
 * deterministically through the real heartbeat. Three agents (two spokes +
 * the chief-of-staff hub), a frozen clock, scripted model outputs — then
 * every observable artifact is asserted: due ordering, report files, ledger
 * trios, the hub's visibility of the day's spoke work, dedup on rerun, and
 * byte-stable report bodies modulo the runId.
 *
 * When behavior changes intentionally, update this day deliberately — it is
 * the closest thing the mesh has to a flight recorder.
 */

const roots: string[] = [];
afterEach(async () => {
  registerProvider(new FakeProvider(), "fake"); // restore the registry default
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

// The frozen day: 2026-07-11, 12:00 ET (16:00Z).
const NOW = new Date("2026-07-11T16:00:00Z");
const TZ = "America/New_York";
const TODAY = "2026-07-11";
const YESTERDAY = "2026-07-10";

const SPOKE_BOOKKEEPER = "## Books\n\nCapital events reconciled; ONE DISCREPANCY of $120 needs you.";
const SPOKE_RESEARCH = "## Radar\n\nTwo competitor moves worth a look; NO ACTION required.";
const HUB_BRIEF = "# Daily brief\n\nBooks: one $120 discrepancy needs you. Radar: quiet. Nag: the bank export is still pending.";

/** Scripted outputs, keyed by the agent name embedded in the harness prompt. */
function scriptedProvider(): FakeProvider {
  return new FakeProvider((opts) => {
    if (opts.prompt.includes(" (bookkeeper),")) return { text: SPOKE_BOOKKEEPER };
    if (opts.prompt.includes(" (research-watch),")) return { text: SPOKE_RESEARCH };
    if (opts.prompt.includes(" (chief-of-staff),")) return { text: HUB_BRIEF };
    throw new Error(`golden day: unscripted prompt — ${opts.prompt.slice(0, 120)}`);
  });
}

function agentConcept(name: string, title: string, job: string): string {
  return concept("agent", { name, title, level: "L1", model: "test-model", harness: "fake", heartbeat: "daily" }, job);
}

async function goldenInstance(): Promise<string> {
  const yts = `${YESTERDAY}T12:00:00.000Z`;
  const ledgerLines = ["bookkeeper", "research-watch", "chief-of-staff"]
    .map((agent) =>
      JSON.stringify({ ts: yts, runId: `y-${agent}`, agent, action: "run-completed", type: "report" }),
    )
    .join("\n");
  const root = await makeTree({
    "animamesh.config.json": JSON.stringify({ bundle: "bundle" }),
    "bundle/index.md": concept("index", { title: "Golden Mesh" }, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/ops/calendar.md": concept("calendar", {}, "# Calendar\n\n- 2026-09-15: annual return due\n"),
    "bundle/ops/nags.md": concept("nags", {}, "# Nags\n\n1. Bank export still pending — day 5 of asking.\n"),
    "bundle/agents/bookkeeper.md": agentConcept("bookkeeper", "Bookkeeper", "Reconcile capital events daily."),
    "bundle/agents/research-watch.md": agentConcept("research-watch", "Research Watch", "Scan the landscape daily."),
    "bundle/agents/chief-of-staff.md": agentConcept("chief-of-staff", "Chief of Staff", "Write the principal's brief from today's mesh reports."),
    "approvals/appr-golden.json": JSON.stringify({
      id: "appr-golden",
      actionType: "government-filing",
      summary: "file the annual return",
      requestedBy: "bookkeeper",
      requestedAt: `${YESTERDAY}T09:00:00Z`,
      status: "pending",
    }),
    "ledger/actions.jsonl": ledgerLines + "\n",
    [`reports/${YESTERDAY}-chief-of-staff-ybrief00.md`]: "---\ntype: report\n---\n\n# Yesterday's brief\n\nquiet day\n",
  });
  roots.push(root);
  return root;
}

describe("the golden day — a scripted mesh day, replayed deterministically", () => {
  it("plays the whole day: due order, three green runs, ledger trios, hub sees the day", async () => {
    const root = await goldenInstance();
    const fake = scriptedProvider();
    registerProvider(fake, "fake");

    const result = await heartbeat({ instanceRoot: root, now: NOW, timeZone: TZ });

    // Due: spokes alphabetically, hub LAST — the brief must read today's work.
    expect(result.due.map((d) => d.agent)).toEqual(["bookkeeper", "research-watch", "chief-of-staff"]);
    expect(result.due.every((d) => d.reason === "daily: not yet run today")).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.runs).toHaveLength(3);
    for (const run of result.runs) {
      expect(run.ok).toBe(true);
      expect(run.verifierResults.every((v) => v.ok)).toBe(true);
    }

    // Three report artifacts for TODAY, named date-agent-runid8.
    const reports = (await readdir(path.join(root, "reports"))).sort();
    const todays = reports.filter((r) => r.startsWith(TODAY));
    expect(todays).toHaveLength(3);
    for (const agent of ["bookkeeper", "chief-of-staff", "research-watch"]) {
      expect(todays.some((r) => new RegExp(`^${TODAY}-${agent}-[0-9a-f]{8}\\.md$`).test(r))).toBe(true);
    }

    // The frozen clock freezes every ledger timestamp; trios land in run order.
    const ledger = (await readFile(path.join(root, "ledger/actions.jsonl"), "utf8")).trim().split("\n");
    const fresh = ledger.slice(3).map((l) => JSON.parse(l) as { ts: string; agent: string; action: string });
    expect(fresh).toHaveLength(9);
    expect(fresh.map((e) => `${e.agent}:${e.action}`)).toEqual([
      "bookkeeper:run-started", "bookkeeper:report-written", "bookkeeper:run-completed",
      "research-watch:run-started", "research-watch:report-written", "research-watch:run-completed",
      "chief-of-staff:run-started", "chief-of-staff:report-written", "chief-of-staff:run-completed",
    ]);
    expect(new Set(fresh.map((e) => e.ts))).toEqual(new Set([NOW.toISOString()]));

    // The hub's prompt contained BOTH of today's spoke reports and the
    // pending approval — the brief reads the day, never recall.
    expect(fake.calls).toHaveLength(3);
    const hubPrompt = fake.calls[2]!.prompt;
    expect(hubPrompt).toContain("ONE DISCREPANCY of $120");
    expect(hubPrompt).toContain("NO ACTION required");
    expect(hubPrompt).toContain("file the annual return"); // pending approval
    expect(hubPrompt).toContain("Bank export still pending"); // ops/nags.md
    expect(hubPrompt).toContain(`Today is ${TODAY}`);

    // Golden bodies: byte-stable modulo the runId line.
    const briefFile = todays.find((r) => r.includes("chief-of-staff"))!;
    const brief = await readFile(path.join(root, "reports", briefFile), "utf8");
    expect(brief.replace(/^runId: .*$/m, "runId: <id>")).toBe(
      [
        "---",
        "type: report",
        "agent: chief-of-staff",
        "runId: <id>",
        `date: ${TODAY}`,
        "harness: fake",
        "model: test-model",
        "---",
        "",
        HUB_BRIEF,
        "",
      ].join("\n"),
    );
  });

  it("replaying the same day is a no-op: dedup skips all three, nothing changes", async () => {
    const root = await goldenInstance();
    registerProvider(scriptedProvider(), "fake");
    await heartbeat({ instanceRoot: root, now: NOW, timeZone: TZ });

    const ledgerBefore = await readFile(path.join(root, "ledger/actions.jsonl"), "utf8");
    const replay = await heartbeat({ instanceRoot: root, now: NOW, timeZone: TZ });

    expect(replay.due).toEqual([]);
    expect(replay.runs).toEqual([]);
    expect(replay.skipped.map((s) => s.reason)).toEqual([
      "daily: already ran today",
      "daily: already ran today",
      "daily: already ran today",
    ]);
    expect(await readFile(path.join(root, "ledger/actions.jsonl"), "utf8")).toBe(ledgerBefore);
  });

  it("the cloud view of the same day skips fake-harness agents with reason", async () => {
    const root = await goldenInstance();
    registerProvider(scriptedProvider(), "fake");
    const result = await heartbeat({ instanceRoot: root, now: NOW, timeZone: TZ, cloudTier: true });
    expect(result.due).toEqual([]);
    expect(result.runs).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "laptop-tier harness (fake) — not run in cloud",
      "laptop-tier harness (fake) — not run in cloud",
      "laptop-tier harness (fake) — not run in cloud",
    ]);
  });
});
