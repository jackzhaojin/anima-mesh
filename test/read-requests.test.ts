import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import * as path from "node:path";
import { makeTree, concept } from "./helpers.js";
import { runAgent } from "../src/harness/run.js";
import { runDirectionCore, type DirectionMessage } from "../src/harness/direction-core.js";
import { FsInstanceStore } from "../src/instance/store-fs.js";
import { FakeProvider } from "../src/providers/fake.js";
import { parseReadRequests, stripReadRequests } from "../src/harness/read-requests.js";

/**
 * Ask-driven retrieval (v0.17.0). The inline heuristics can't know what THIS
 * run is about — "read my 2015 agreement" loses every recency race. The model
 * ends its output with a `read-request` block; deterministic code validates,
 * serves, ledgers, and runs the agent ONCE more.
 *
 * What must hold: the loop is exactly one round; every refusal (undeclared
 * source, jailed path, cap overflow, missing file) is a visible line in the
 * served section; the final artifact carries no request blocks; the ledger
 * records the retrieval.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function makeInstance(extraFiles: Record<string, string> = {}) {
  const root = await makeTree({
    "animamesh.config.json": JSON.stringify({ bundle: "bundle" }, null, 2),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/agents/hub.md": concept(
      "agent",
      { name: "hub", title: "Hub", level: "L1", model: "test-model", harness: "fake" },
      "Coordinate the mesh.",
    ),
    "bundle/cabinet/legal.md": concept("document-set", {}, "# Legal file\n\nThe clause text: ALPHA-42.\n"),
    ...extraFiles,
  });
  roots.push(root);
  return root;
}

/** A provider that asks for reads on call 1 and reports on call 2. */
function askingProvider(block: string, finalText = "Final report: grounded in ALPHA-42.") {
  let call = 0;
  return new FakeProvider(() => {
    call++;
    return call === 1 ? { text: `I need a file first.\n\n${block}\n` } : { text: finalText };
  });
}

const REQUEST_BLOCK = "```read-request\nbundle: [cabinet/legal.md]\n```";

describe("parse + strip", () => {
  it("parses multi-source blocks into source/path pairs", () => {
    const text = 'x\n```read-request\nonedrive: [Legal/a.pdf, "Finance/b.csv"]\nbundle: [cabinet/c.md]\n```\ny';
    expect(parseReadRequests(text)).toEqual([
      { source: "onedrive", path: "Legal/a.pdf" },
      { source: "onedrive", path: "Finance/b.csv" },
      { source: "bundle", path: "cabinet/c.md" },
    ]);
  });

  it("marks an unparseable block instead of dropping it", () => {
    const requests = parseReadRequests("```read-request\n: [broken\n```");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.source).toBe("(malformed)");
  });

  it("strips request blocks and collapses the gap", () => {
    const stripped = stripReadRequests(`before\n\n${REQUEST_BLOCK}\n\nafter`);
    expect(stripped).not.toContain("read-request");
    expect(stripped).toBe("before\n\nafter");
  });
});

describe("the retrieval loop — beat runs", () => {
  it("serves a requested bundle file and runs exactly one continuation", async () => {
    const root = await makeInstance();
    const provider = askingProvider(REQUEST_BLOCK);
    const report = await runAgent({ instanceRoot: root, agentName: "hub", provider, runId: "run-reads-1" });

    expect(provider.calls).toHaveLength(2);
    // Call 1 was told about the capability; call 2 got the served file.
    expect(provider.calls[0]!.prompt).toContain("On-demand reads (one round)");
    expect(provider.calls[1]!.prompt).toContain("## Requested reads (served at your request)");
    expect(provider.calls[1]!.prompt).toContain("ALPHA-42");
    expect(provider.calls[1]!.prompt).toContain("produce your complete final output now");

    // The artifact is the continuation's report, block-free.
    const artifact = await readFile(report.reportPath, "utf8");
    expect(artifact).toContain("Final report: grounded in ALPHA-42.");
    expect(artifact).not.toContain("read-request");

    // The retrieval is ledgered.
    const lines = (await readFile(path.join(root, "ledger/actions.jsonl"), "utf8")).trim().split("\n");
    const entry = lines.map((l) => JSON.parse(l)).find((e) => e.action === "reads-requested");
    expect(entry?.detail).toMatchObject({ requested: 1, served: 1, refused: 0 });
    expect(report.ok).toBe(true);
  });

  it("refuses out loud: undeclared source, jailed paths, missing files; extras dropped by name", async () => {
    const root = await makeInstance();
    const block = [
      "```read-request",
      "onedrive: [Finance/x.csv]",
      "bundle: [../secrets.md, /etc/passwd, cabinet/missing.md, cabinet/fifth.md]",
      "```",
    ].join("\n");
    const provider = askingProvider(block, "Final report: nothing served.");
    await runAgent({ instanceRoot: root, agentName: "hub", provider, runId: "run-reads-2" });

    expect(provider.calls).toHaveLength(2);
    const served = provider.calls[1]!.prompt;
    expect(served).toContain("source 'onedrive' is not available to this agent");
    expect(served).toContain("path escapes the jail");
    expect(served).toContain("not found in the bundle");
    // 5 requests, cap 4: the fifth is dropped BY NAME, never silently.
    expect(served).toContain("1 more request(s) dropped");
    expect(served).toContain("cabinet/fifth.md");

    const lines = (await readFile(path.join(root, "ledger/actions.jsonl"), "utf8")).trim().split("\n");
    const entry = lines.map((l) => JSON.parse(l)).find((e) => e.action === "reads-requested");
    expect(entry?.detail).toMatchObject({ requested: 5, served: 0, refused: 4 });
  });

  it("one round only: a request in the continuation is stripped, never served", async () => {
    const root = await makeInstance();
    // Greedy agent: asks for a read on EVERY call.
    const provider = new FakeProvider(() => ({ text: `Still curious.\n\n${REQUEST_BLOCK}\n` }));
    const report = await runAgent({ instanceRoot: root, agentName: "hub", provider, runId: "run-reads-3" });

    expect(provider.calls).toHaveLength(2); // never a third call
    const artifact = await readFile(report.reportPath, "utf8");
    expect(artifact).not.toContain("read-request");
    expect(artifact).toContain("Still curious.");
  });

  it("no request, no continuation — the loop costs nothing when unused", async () => {
    const root = await makeInstance();
    const provider = new FakeProvider(() => ({ text: "Plain report." }));
    await runAgent({ instanceRoot: root, agentName: "hub", provider, runId: "run-reads-4" });
    expect(provider.calls).toHaveLength(1);
  });
});

describe("the retrieval loop — direction runs", () => {
  const MESSAGE: DirectionMessage = {
    channel: "discord",
    sender: "principal-1",
    text: "what does our legal file actually say?",
    receivedAt: "2026-08-03T16:00:00.000Z",
    messageId: "m-1",
  };

  it("serves reads mid-direction and replies from the continuation, block-free", async () => {
    const root = await makeInstance({
      "bundle/agents/hub.md": concept(
        "agent",
        { name: "hub", title: "Hub", level: "L1", model: "test-model", harness: "fake", heartbeat: "daily" },
        "Coordinate the mesh; answer the principal.",
      ),
    });
    const provider = askingProvider(REQUEST_BLOCK, "It says ALPHA-42 — read this run at your ask.");
    const report = await runDirectionCore({
      store: new FsInstanceStore(root),
      message: MESSAGE,
      agentName: "hub",
      provider,
      now: new Date("2026-08-03T16:00:00Z"),
    });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.prompt).toContain("ALPHA-42");
    expect(report.reply).toBe("It says ALPHA-42 — read this run at your ask.");
    expect(report.reply).not.toContain("read-request");
    expect(report.ok).toBe(true);
  });
});
