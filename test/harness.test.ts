import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { makeTree, concept, minimalAnimaMeshFiles } from "./helpers.js";
import { runAgent } from "../src/harness/run.js";
import { FakeProvider } from "../src/providers/fake.js";
import { resolveProvider, registerProvider } from "../src/providers/index.js";
import { ActivationGateError } from "../src/agents/concept.js";
import { Ledger } from "../src/ledger/ledger.js";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

/** A minimal but complete instance: config + animamesh-conformant bundle + one agent. */
async function makeInstance(extra: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const files: Record<string, string> = {
    "animamesh.config.json": JSON.stringify({ bundle: "bundle", ...config }, null, 2),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/ops/calendar.md": concept("calendar", {}, "# Calendar\n\n- 2026-09-15: file the annual return\n"),
    "bundle/agents/scout.md": concept(
      "agent",
      { name: "scout", title: "Scout", level: "L1", model: "test-model", harness: "fake" },
      "Wake daily, read the calendar, report what needs the principal today.",
    ),
    ...extra,
  };
  const root = await makeTree(files);
  roots.push(root);
  return root;
}

describe("runAgent — the one seam, end to end", () => {
  it("produces a report artifact, a complete ledger, and green verifiers", async () => {
    const root = await makeInstance();
    const fake = new FakeProvider(() => ({ text: "## Daily brief\n\nNothing needs you today." }));
    const report = await runAgent({ instanceRoot: root, agentName: "scout", provider: fake, runId: "run-e2e" });

    expect(report.ok).toBe(true);
    expect(report.verifierResults.every((v) => v.ok)).toBe(true);

    // (a) repo diff: the report artifact exists with harness frontmatter
    expect(existsSync(report.reportPath)).toBe(true);
    const written = readFileSync(report.reportPath, "utf8");
    expect(written).toContain("type: report");
    expect(written).toContain("agent: scout");
    expect(written).toContain("runId: run-e2e");
    expect(written).toContain("Nothing needs you today.");

    // (c) ledger completeness: all three declared actions, in order
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-e2e");
    expect(entries.map((e) => e.action)).toEqual(["run-started", "report-written", "run-completed"]);
  });

  it("assembles the prompt from the job + bundle context, not model recall", async () => {
    const root = await makeInstance();
    const fake = new FakeProvider(() => ({ text: "ok" }));
    await runAgent({ instanceRoot: root, agentName: "scout", provider: fake });

    expect(fake.calls).toHaveLength(1);
    const prompt = fake.calls[0]!.prompt;
    expect(prompt).toContain("read the calendar");            // agent job body
    expect(prompt).toContain("file the annual return");        // inlined calendar concept
    expect(prompt).toContain("never on recall");               // operating rules
    expect(prompt).toContain("report-only");                   // L1 meaning
    expect(fake.calls[0]!.model).toBe("test-model");           // chokepoint honors the concept
  });

  it("feeds latest spoke reports and pending approvals into the prompt — the hub sees the mesh", async () => {
    const root = await makeInstance({
      "reports/2026-07-04-scout-aaaa.md": "---\ntype: report\n---\n\nYesterday: nothing needed.",
      "approvals/x.json": JSON.stringify({
        id: "x", actionType: "government-filing", summary: "file the annual return",
        requestedBy: "scout", requestedAt: "2026-07-04T00:00:00Z", status: "pending",
      }),
    });
    const fake = new FakeProvider(() => ({ text: "brief" }));
    await runAgent({ instanceRoot: root, agentName: "scout", provider: fake });
    const prompt = fake.calls[0]!.prompt;
    expect(prompt).toContain("Latest reports from the mesh");
    expect(prompt).toContain("Yesterday: nothing needed.");
    expect(prompt).toContain("Pending approvals");
    expect(prompt).toContain("file the annual return");
  });

  it("fails loud on unknown agents", async () => {
    const root = await makeInstance();
    await expect(runAgent({ instanceRoot: root, agentName: "ghost", provider: new FakeProvider() }))
      .rejects.toThrow(/agent 'ghost' not found/);
  });

  it("blocks commercial agents without the D11 dual gate — capability never outruns permission", async () => {
    const commercial = concept(
      "agent",
      { name: "closer", title: "Sales Qual", level: "L1", model: "m", harness: "fake", commercial: true },
      "Qualify inbound leads.",
    );
    const rootBlocked = await makeInstance({ "bundle/agents/closer.md": commercial });
    await expect(runAgent({ instanceRoot: rootBlocked, agentName: "closer", provider: new FakeProvider() }))
      .rejects.toThrow(ActivationGateError);

    // boundary map alone is not enough
    const rootHalf = await makeInstance(
      { "bundle/agents/closer.md": commercial },
      { activation: { boundaryMapVerified: true } },
    );
    await expect(runAgent({ instanceRoot: rootHalf, agentName: "closer", provider: new FakeProvider() }))
      .rejects.toThrow(ActivationGateError);

    // boundary map + explicit waiver opens the gate
    const rootOpen = await makeInstance(
      { "bundle/agents/closer.md": commercial },
      { activation: { boundaryMapVerified: true, founderWaiver: true } },
    );
    const report = await runAgent({ instanceRoot: rootOpen, agentName: "closer", provider: new FakeProvider() });
    expect(report.ok).toBe(true);
  });

  it("keeps verifiers honest: a conformance break in the bundle fails the run", async () => {
    const root = await makeInstance({ "bundle/rogue.md": "# no frontmatter at all\n" });
    const report = await runAgent({ instanceRoot: root, agentName: "scout", provider: new FakeProvider() });
    expect(report.ok).toBe(false);
    const conformance = report.verifierResults.find((v) => v.name === "bundle-conformance")!;
    expect(conformance.ok).toBe(false);
  });
});

describe("provider registry — the D14 chokepoint", () => {
  it("resolves built-ins and rejects unknowns", () => {
    expect(resolveProvider("fake").name).toBe("fake");
    expect(resolveProvider("claude-code").name).toBe("claude-code");
    expect(resolveProvider("opencode").name).toBe("opencode");
    expect(() => resolveProvider("gpt-magic")).toThrow(/unknown harness 'gpt-magic'/);
  });

  it("accepts instance-registered providers", async () => {
    const custom = new FakeProvider(() => ({ text: "custom" }));
    registerProvider(custom, "my-harness");
    expect(resolveProvider("my-harness")).toBe(custom);
  });

  it("fake provider records calls for the regression suite", async () => {
    const fake = new FakeProvider(() => ({ text: "hi" }));
    await fake.run({ prompt: "p", cwd: "/tmp" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.prompt).toBe("p");
  });
});
