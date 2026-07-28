import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { makeTree, concept } from "./helpers.js";
import { runAgent } from "../src/harness/run.js";
import { FakeProvider } from "../src/providers/fake.js";
import { providerCapabilities, NO_CAPABILITIES } from "../src/providers/index.js";
import { agentFromConcept } from "../src/agents/concept.js";
import { parseConcept } from "../src/okf/frontmatter.js";

/**
 * The issue #4 regression suite.
 *
 * Two cloud runs (2026-07-25 research-watch, 2026-07-26 chief-of-staff)
 * reported that "the external web-fetch tool returned no usable content".
 * There was no tool: `anthropic-api` sends no `tools` array, while the
 * agent's job description budgeted "~8 web fetches per heartbeat". The model
 * could not tell a missing capability from a failing one, so it reported a
 * broken tool — and unchecked subjects nearly became "nothing changed".
 *
 * What must hold forever after: an agent is TOLD what its harness grants,
 * the telling contradicts its own job description when the two disagree, and
 * asking for a capability the harness lacks produces a loud absence.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function makeInstance(agentFrontmatter: Record<string, unknown> = {}, job = "Watch the market.") {
  const files: Record<string, string> = {
    "animamesh.config.json": JSON.stringify({ bundle: "bundle" }, null, 2),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/agents/watcher.md": concept(
      "agent",
      { name: "watcher", title: "Watcher", level: "L1", model: "test-model", harness: "fake", ...agentFrontmatter },
      job,
    ),
  };
  const root = await makeTree(files);
  roots.push(root);
  return root;
}

/** Run once and hand back the prompt the provider actually received. */
async function promptFor(root: string, provider: FakeProvider): Promise<string> {
  await runAgent({ instanceRoot: root, agentName: "watcher", provider, runId: "run-cap" });
  return provider.calls[0]!.prompt;
}

describe("capability disclosure in the prompt (issue #4)", () => {
  it("states plainly that a no-tool harness has no web and no files", async () => {
    const root = await makeInstance();
    const prompt = await promptFor(root, new FakeProvider());

    expect(prompt).toContain("## Your capabilities this run");
    expect(prompt).toContain("**Web search: NO.**");
    expect(prompt).toContain("**File reads: NO.**");
    // The section must be able to overrule a stale job description.
    expect(prompt).toContain("override anything your job description implies");
  });

  it("declares file reads only for harnesses that actually grant them", async () => {
    const root = await makeInstance();
    const withFiles = new FakeProvider(undefined, { fileReads: true, webSearch: false });
    const prompt = await promptFor(root, withFiles);

    expect(prompt).toContain("**File reads: YES.**");
    expect(prompt).toContain("Your working directory is the bundle root");
  });

  it("grants the concept's web budget when the harness can search", async () => {
    const root = await makeInstance({ web: 8 });
    const webby = new FakeProvider(undefined, { fileReads: false, webSearch: true });
    const prompt = await promptFor(root, webby);

    expect(prompt).toContain("**Web search: YES**, up to 8 searches this run");
    // And the budget reaches the provider, not just the prose.
    expect(webby.calls[0]!.webSearchMaxUses).toBe(8);
  });

  it("makes a declared-but-unavailable capability LOUD — the exact issue #4 shape", async () => {
    // The failing configuration verbatim: a job that budgets fetches, on a
    // harness with no web at all.
    const root = await makeInstance({ web: 8 }, "Budget ~8 web fetches per heartbeat and digest what changed.");
    const noWeb = new FakeProvider();
    const prompt = await promptFor(root, noWeb);

    expect(prompt).toContain("**Web search: NO — and your concept asks for 8.**");
    expect(prompt).toContain("Do NOT attempt fetches");
    expect(prompt).toContain("report plainly that the capability is absent");
    // Never hand a budget to a provider that cannot honour it.
    expect(noWeb.calls[0]!.webSearchMaxUses).toBeUndefined();
  });

  it("never claims a capability an undeclared provider might not have", () => {
    const silent = { name: "mystery", assertConfigured() {}, async run() { return { text: "" }; } };
    expect(providerCapabilities(silent)).toEqual(NO_CAPABILITIES);
    expect(NO_CAPABILITIES).toEqual({ fileReads: false, webSearch: false });
  });
});

describe("agent concept — the `web:` budget", () => {
  const parse = (fm: Record<string, unknown>) => {
    const raw = concept("agent", { name: "w", level: "L1", model: "m", harness: "fake", ...fm }, "job");
    const parsed = parseConcept(raw)!;
    return agentFromConcept({
      path: "agents/w.md",
      relPath: "agents/w.md",
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      missingFrontmatter: false,
    });
  };

  it("defaults to zero — web access is opt-in, never inherited", () => {
    expect(parse({}).web).toBe(0);
  });

  it("reads a positive integer budget", () => {
    expect(parse({ web: 8 }).web).toBe(8);
  });

  it("treats nonsense budgets as no budget rather than guessing", () => {
    expect(parse({ web: -3 }).web).toBe(0);
    expect(parse({ web: "lots" }).web).toBe(0);
    expect(parse({ web: 2.7 }).web).toBe(2);
  });
});
