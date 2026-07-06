import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { makeTree, concept } from "./helpers.js";
import { heartbeat, PERIOD_HOURS } from "../src/harness/heartbeat.js";
import { buildAgentCard } from "../src/a2a/card.js";
import { Ledger } from "../src/ledger/ledger.js";
import * as path from "node:path";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function agentFile(name: string, cadence: string | undefined, extra: Record<string, unknown> = {}) {
  return concept(
    "agent",
    { name, title: name, level: "L1", model: "m", harness: "fake", ...(cadence ? { heartbeat: cadence } : {}), ...extra },
    `Job of ${name}.`,
  );
}

async function makeMeshInstance(config: Record<string, unknown> = {}) {
  const root = await makeTree({
    "animamesh.config.json": JSON.stringify({
      bundle: "bundle",
      identity: { principal: { name: "Pat", email: "pat@example.com" }, persona: { name: "Vesper" } },
      engine: { ref: "v9.9.9" },
      ...config,
    }),
    "bundle/index.md": concept("index", { title: "Mesh Test Org — bundle" }, "# I"),
    "bundle/log.md": concept("log", {}, "# L"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# C"),
    "bundle/agents/beta-daily.md": agentFile("beta-daily", "daily"),
    "bundle/agents/alpha-daily.md": agentFile("alpha-daily", "daily"),
    "bundle/agents/weekly-w.md": agentFile("weekly-w", "weekly"),
    "bundle/agents/manual-m.md": agentFile("manual-m", undefined),
    "bundle/agents/chief-of-staff.md": agentFile("chief-of-staff", "daily"),
    "bundle/agents/closer.md": agentFile("closer", "daily", { commercial: true }),
  });
  roots.push(root);
  return root;
}

describe("heartbeat — D5's deterministic trigger", () => {
  it("first beat: everything with a cadence is due; commercial and manual are skipped; hub runs LAST", async () => {
    const root = await makeMeshInstance();
    const result = await heartbeat({ instanceRoot: root });

    expect(result.ok).toBe(true);
    expect(result.due.map((d) => d.agent)).toEqual(["alpha-daily", "beta-daily", "weekly-w", "chief-of-staff"]);
    expect(result.runs.map((r) => r.agent)).toEqual(["alpha-daily", "beta-daily", "weekly-w", "chief-of-staff"]);
    expect(result.skipped.find((s) => s.agent === "closer")!.reason).toContain("dual-gated");
    expect(result.skipped.find((s) => s.agent === "manual-m")!.reason).toContain("manual");
  });

  it("second beat right after: nothing is due", async () => {
    const root = await makeMeshInstance();
    await heartbeat({ instanceRoot: root });
    const again = await heartbeat({ instanceRoot: root });
    expect(again.due).toEqual([]);
    expect(again.runs).toEqual([]);
  });

  it("daily comes due after ~a day; weekly holds", async () => {
    const root = await makeMeshInstance();
    await heartbeat({ instanceRoot: root });

    const tomorrow = new Date(Date.now() + 26 * 3_600_000);
    const later = await heartbeat({ instanceRoot: root, now: tomorrow, dryRun: true });
    const dueNames = later.due.map((d) => d.agent);
    expect(dueNames).toContain("alpha-daily");
    expect(dueNames).toContain("chief-of-staff");
    expect(dueNames).not.toContain("weekly-w");
  });

  it("one spoke's failure never aborts the beat — remaining agents still run", async () => {
    const root = await makeMeshInstance();
    // alpha-daily's harness doesn't exist → its run throws; the rest proceed.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const alphaPath = path.join(root, "bundle/agents/alpha-daily.md");
    writeFileSync(alphaPath, readFileSync(alphaPath, "utf8").replace("harness: fake", "harness: broken-harness"));

    const result = await heartbeat({ instanceRoot: root });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.agent).toBe("alpha-daily");
    expect(result.failures[0]!.error).toContain("broken-harness");
    // everyone after the failure still ran, hub still last
    expect(result.runs.map((r) => r.agent)).toEqual(["beta-daily", "weekly-w", "chief-of-staff"]);
  });

  it("dry-run decides but never runs", async () => {
    const root = await makeMeshInstance();
    const result = await heartbeat({ instanceRoot: root, dryRun: true });
    expect(result.due.length).toBeGreaterThan(0);
    expect(result.runs).toEqual([]);
    const ledger = new Ledger(path.join(root, "ledger/actions.jsonl"));
    expect(ledger.read()).toEqual([]);
  });

  it("thresholds are slightly under-period so cron drift never skips a day", () => {
    expect(PERIOD_HOURS.daily).toBeLessThan(24);
    expect(PERIOD_HOURS.weekly).toBeLessThan(7 * 24);
    expect(PERIOD_HOURS.monthly).toBeLessThan(30 * 24);
    expect(PERIOD_HOURS.quarterly).toBeLessThan(90 * 24);
  });
});

describe("A2A agent card — the mesh's front door", () => {
  it("advertises the hub identity and only runnable skills", async () => {
    const root = await makeMeshInstance();
    const card = await buildAgentCard(root);

    expect(card.protocolVersion).toBe("1.0");
    expect(card.name).toBe("Vesper — Chief of Staff");
    expect(card.version).toBe("v9.9.9");
    expect(card.url).toBe("urn:anima-mesh:local-instance");

    const skillIds = card.skills.map((s) => s.id);
    expect(skillIds).toContain("alpha-daily");
    expect(skillIds).toContain("chief-of-staff");
    expect(skillIds).not.toContain("closer"); // dual-gated commercial is not advertised
  });

  it("advertises commercial skills once the dual gate opens", async () => {
    const root = await makeMeshInstance({
      activation: { boundaryMapVerified: true, founderWaiver: true },
    });
    const card = await buildAgentCard(root);
    expect(card.skills.map((s) => s.id)).toContain("closer");
  });

  it("honors a configured public URL", async () => {
    const root = await makeMeshInstance({ a2a: { url: "https://mesh.example/.well-known/agent-card.json" } });
    const card = await buildAgentCard(root);
    expect(card.url).toBe("https://mesh.example/.well-known/agent-card.json");
  });
});
