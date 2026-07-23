import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { makeTree, concept } from "./helpers.js";
import { runAgent } from "../src/harness/run.js";
import { runDirectionCore, type DirectionMessage } from "../src/harness/direction-core.js";
import { parseDraftRequests, stripDraftRequests, draftPathViolation, MAX_DRAFTS_PER_RUN } from "../src/harness/drafts.js";
import { FakeProvider } from "../src/providers/fake.js";
import { Ledger } from "../src/ledger/ledger.js";

/**
 * Draft requests — the schedule-request pattern generalized to artifacts.
 * These prove the contract from drafts.ts: model proposes, code disposes;
 * a promised write lands in the same run or its denial is ledgered; the
 * jail keeps every write strictly under the drafts dir.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function draftBlock(p: string, content: string): string {
  return ["```draft-request", `path: ${p}`, "---", content, "```"].join("\n");
}

function agentFile(name: string, extra: Record<string, unknown> = {}): string {
  return concept("agent", { name, title: name, level: "L1", model: "test-model", harness: "fake", ...extra }, "Do the job.");
}

async function makeInstance(extra: Record<string, string> = {}): Promise<string> {
  const root = await makeTree({
    "animamesh.config.json": JSON.stringify({ bundle: "bundle" }),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    ...extra,
  });
  roots.push(root);
  return root;
}

describe("parseDraftRequests / stripDraftRequests", () => {
  it("extracts path and full content from each block; malformed or empty blocks are skipped", () => {
    const text = [
      "Report prose.",
      draftBlock("nag-prep/07-plan.md", "# Prep\n\nOutline."),
      "More prose.",
      draftBlock("nag-prep/08-pitch.md", "# Pitch prep\n"),
      "```draft-request\nno path line here\n```", // malformed → skipped
      draftBlock("nag-prep/empty.md", "   \n"), // empty content → skipped
    ].join("\n\n");
    const reqs = parseDraftRequests(text);
    expect(reqs.map((r) => r.path)).toEqual(["nag-prep/07-plan.md", "nag-prep/08-pitch.md"]);
    expect(reqs[0]!.content).toContain("Outline.");
  });

  it("strip removes the blocks and leaves the prose", () => {
    const text = `Before.\n\n${draftBlock("a.md", "content")}\n\nAfter.`;
    const stripped = stripDraftRequests(text);
    expect(stripped).toContain("Before.");
    expect(stripped).toContain("After.");
    expect(stripped).not.toContain("draft-request");
    expect(stripped).not.toContain("content");
  });
});

describe("draftPathViolation — the jail", () => {
  it("accepts clean nested .md paths and rejects escapes", () => {
    expect(draftPathViolation("nag-prep/07-plan.md")).toBeNull();
    expect(draftPathViolation("deep/nested/dir/file.md")).toBeNull();
    expect(draftPathViolation("/etc/passwd.md")).toMatch(/absolute/);
    expect(draftPathViolation("C:/windows/file.md")).toMatch(/absolute/);
    expect(draftPathViolation("../bundle/constitution.md")).toMatch(/segments/);
    expect(draftPathViolation("a/../../ledger/actions.jsonl.md")).toMatch(/segments/);
    expect(draftPathViolation("a//b.md")).toMatch(/segments/);
    expect(draftPathViolation("prep\\file.md")).toMatch(/backslash/);
    expect(draftPathViolation("script.sh")).toMatch(/\.md/);
  });
});

describe("draft-write through a beat run — model proposes, code disposes", () => {
  const REPORT = ["## Brief", "", "Prep pack updated.", "", draftBlock("nag-prep/07-plan.md", "# Plan prep\n\n- outline\n"), ""].join("\n");

  it("applies from an L3 agent with draft-write whitelisted: file written, ledgered, verifiers green", async () => {
    const root = await makeInstance({
      "bundle/agents/hub.md": agentFile("hub", { level: "L3", whitelist: ["draft-write"], heartbeat: "daily" }),
    });
    const fake = new FakeProvider(() => ({ text: REPORT }));
    const report = await runAgent({ instanceRoot: root, agentName: "hub", provider: fake, runId: "run-draft" });

    expect(report.ok).toBe(true);
    const written = await readFile(path.join(root, "drafts/nag-prep/07-plan.md"), "utf8");
    expect(written).toContain("# Plan prep");

    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-draft");
    const applied = entries.find((e) => e.action === "draft-written");
    expect(applied?.detail).toEqual({ path: "drafts/nag-prep/07-plan.md", bytes: expect.any(Number) });
  });

  it("denies from an L1 agent: ledgered, no file, run itself unaffected", async () => {
    const root = await makeInstance({
      "bundle/agents/hub.md": agentFile("hub", { heartbeat: "daily" }), // L1, empty whitelist
    });
    const fake = new FakeProvider(() => ({ text: REPORT }));
    const report = await runAgent({ instanceRoot: root, agentName: "hub", provider: fake, runId: "run-deny" });

    expect(report.ok).toBe(true);
    expect(existsSync(path.join(root, "drafts/nag-prep/07-plan.md"))).toBe(false);
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-deny");
    const denied = entries.find((e) => e.action === "draft-request-denied");
    expect(denied).toBeDefined();
    expect(String((denied?.detail as { reason?: string }).reason)).toContain("ladder");
  });

  it("jails an escaping path: denial ledgered, nothing written outside drafts/", async () => {
    const evil = ["## Brief", "", draftBlock("../bundle/constitution.md", "# Overwritten\n"), ""].join("\n");
    const root = await makeInstance({
      "bundle/agents/hub.md": agentFile("hub", { level: "L3", whitelist: ["draft-write"], heartbeat: "daily" }),
    });
    const fake = new FakeProvider(() => ({ text: evil }));
    await runAgent({ instanceRoot: root, agentName: "hub", provider: fake, runId: "run-jail" });

    const constitution = await readFile(path.join(root, "bundle/constitution.md"), "utf8");
    expect(constitution).not.toContain("Overwritten");
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-jail");
    const denied = entries.find((e) => e.action === "draft-request-denied");
    expect(String((denied?.detail as { reason?: string }).reason)).toContain("segments");
  });

  it("caps a runaway run: writes the first N, ledgers the overflow as denied", async () => {
    const blocks = Array.from({ length: MAX_DRAFTS_PER_RUN + 2 }, (_, i) => draftBlock(`p${i}.md`, `# ${i}\n`));
    const root = await makeInstance({
      "bundle/agents/hub.md": agentFile("hub", { level: "L3", whitelist: ["draft-write"], heartbeat: "daily" }),
    });
    const fake = new FakeProvider(() => ({ text: `## Brief\n\n${blocks.join("\n\n")}\n` }));
    await runAgent({ instanceRoot: root, agentName: "hub", provider: fake, runId: "run-cap" });

    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-cap");
    expect(entries.filter((e) => e.action === "draft-written").length).toBe(MAX_DRAFTS_PER_RUN);
    const overflow = entries.find(
      (e) => e.action === "draft-request-denied" && String((e.detail as { reason?: string }).reason).includes("cap"),
    );
    expect(overflow).toBeDefined();
  });
});

describe("draft-write through a direction run — the DM-to-artifact loop", () => {
  const NOW = new Date("2026-07-23T16:00:00Z");
  const MESSAGE: DirectionMessage = {
    channel: "discord",
    sender: "principal-42",
    text: "More prep on nag 7 please — outline only.",
    receivedAt: NOW.toISOString(),
    messageId: "interaction-9",
  };

  it("applies the draft, strips the block from the reply, and lists the file in the report", async () => {
    const root = await makeInstance({
      "bundle/agents/chief-of-staff.md": agentFile("chief-of-staff", {
        level: "L3",
        whitelist: ["schedule-update", "draft-write"],
        heartbeat: "daily",
      }),
      "ledger/actions.jsonl": "",
    });
    const fake = new FakeProvider(() => ({
      text: `Updated the nag 7 prep — outline only, as asked. See drafts/nag-prep/07-plan.md.\n\n${draftBlock(
        "nag-prep/07-plan.md",
        "# Nag 7 prep (outline)\n\n1. Identity\n2. Market\n",
      )}\n`,
    }));
    const { FsInstanceStore } = await import("../src/instance/store-fs.js");
    const result = await runDirectionCore({
      store: new FsInstanceStore(root),
      message: MESSAGE,
      provider: fake,
      now: NOW,
      timeZone: "America/New_York",
      runId: "dir-draft",
    });

    expect(result.ok).toBe(true);
    // the artifact landed
    const written = await readFile(path.join(root, "drafts/nag-prep/07-plan.md"), "utf8");
    expect(written).toContain("# Nag 7 prep (outline)");
    // the chat reply is clean prose — no fenced file dump
    expect(result.reply).toContain("Updated the nag 7 prep");
    expect(result.reply).not.toContain("draft-request");
    // the evidence report names the file
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("## Drafts written this run");
    expect(report).toContain("drafts/nag-prep/07-plan.md");
    // ledgered under the direction run
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("dir-draft");
    expect(entries.some((e) => e.action === "draft-written")).toBe(true);
  });

  it("a direction to an unwhitelisted agent cannot write drafts", async () => {
    const root = await makeInstance({
      "bundle/agents/chief-of-staff.md": agentFile("chief-of-staff", { heartbeat: "daily" }), // L1
      "ledger/actions.jsonl": "",
    });
    const fake = new FakeProvider(() => ({
      text: `Done!\n\n${draftBlock("nag-prep/07-plan.md", "# sneaky\n")}\n`,
    }));
    const { FsInstanceStore } = await import("../src/instance/store-fs.js");
    const result = await runDirectionCore({
      store: new FsInstanceStore(root),
      message: MESSAGE,
      provider: fake,
      now: NOW,
      timeZone: "America/New_York",
      runId: "dir-deny",
    });
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(root, "drafts/nag-prep/07-plan.md"))).toBe(false);
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("dir-deny");
    expect(entries.some((e) => e.action === "draft-request-denied")).toBe(true);
  });
});
