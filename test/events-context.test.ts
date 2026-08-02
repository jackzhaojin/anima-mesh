import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { makeTree, concept } from "./helpers.js";
import { runAgent } from "../src/harness/run.js";
import { FakeProvider } from "../src/providers/fake.js";

/**
 * Recent events in every run's context (v0.16.0).
 *
 * The bundle's conventions route every correction and settled fact through
 * an append-only `events/` concept — but no harness surface carried them.
 * On a no-tool harness a fresh event was invisible: agents re-derived (and
 * re-litigated) questions the principal had already settled, burning search
 * budget on facts that were sitting in the bundle the whole time.
 *
 * What must hold: the newest events are inlined for EVERY agent — no reads:
 * declaration needed — newest first, count out loud, clipped visibly.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function makeInstance(extraFiles: Record<string, string> = {}) {
  const files: Record<string, string> = {
    "animamesh.config.json": JSON.stringify({ bundle: "bundle" }, null, 2),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/agents/hub.md": concept(
      "agent",
      { name: "hub", title: "Hub", level: "L1", model: "test-model", harness: "fake" },
      "Coordinate the mesh.",
    ),
    ...extraFiles,
  };
  const root = await makeTree(files);
  roots.push(root);
  return root;
}

async function promptFor(root: string): Promise<string> {
  const provider = new FakeProvider();
  await runAgent({ instanceRoot: root, agentName: "hub", provider, runId: "run-events" });
  return provider.calls[0]!.prompt;
}

describe("recent events in the assembled context", () => {
  it("inlines events for an agent with no reads: declaration — ambient, not opt-in", async () => {
    const root = await makeInstance({
      "bundle/events/2026-08-01-billing-settled.md": concept(
        "event",
        {},
        "# Billing question settled\n\nThe split was pulled; no separate bucket.\n",
      ),
    });
    const prompt = await promptFor(root);

    expect(prompt).toContain("### Recent events (1 of 1, newest first");
    expect(prompt).toContain("#### events/2026-08-01-billing-settled.md");
    expect(prompt).toContain("The split was pulled; no separate bucket.");
    // The framing tells the agent events beat stale derivations.
    expect(prompt).toContain("an event supersedes older reports");
  });

  it("shows the newest events first and caps the count OUT LOUD", async () => {
    const files: Record<string, string> = {};
    for (let d = 1; d <= 7; d++) {
      files[`bundle/events/2026-07-0${d}-event.md`] = `event of day ${d}\n`;
    }
    const root = await makeInstance(files);
    const prompt = await promptFor(root);

    expect(prompt).toContain("### Recent events (5 of 7, newest first");
    // Newest inlined, oldest two dropped.
    expect(prompt).toContain("#### events/2026-07-07-event.md");
    expect(prompt).toContain("#### events/2026-07-03-event.md");
    expect(prompt).not.toContain("#### events/2026-07-02-event.md");
    expect(prompt).not.toContain("#### events/2026-07-01-event.md");
    // Newest-first order: day 7 appears before day 3.
    expect(prompt.indexOf("2026-07-07-event.md")).toBeLessThan(prompt.indexOf("2026-07-03-event.md"));
  });

  it("omits the section entirely when the bundle has no events", async () => {
    const root = await makeInstance();
    const prompt = await promptFor(root);

    expect(prompt).not.toContain("### Recent events");
  });

  it("clips an oversized event with a visible truncation note", async () => {
    const root = await makeInstance({
      "bundle/events/2026-08-01-long.md": "y".repeat(5000),
    });
    const prompt = await promptFor(root);

    expect(prompt).toContain("#### events/2026-08-01-long.md");
    expect(prompt).toContain("…(truncated by the harness)");
    expect(prompt).not.toContain("y".repeat(3001));
  });
});
