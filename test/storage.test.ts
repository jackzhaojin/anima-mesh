import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, readdir, writeFile, mkdir, chmod } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { makeTree, concept } from "./helpers.js";
import { conflictCopies, conflictCopyReason, portabilityIssues, sanitizeWriter } from "../src/instance/storage-core.js";
import { Ledger } from "../src/ledger/ledger.js";
import { FsInstanceStore } from "../src/instance/store-fs.js";
import { ApprovalStore } from "../src/gates/approvals.js";
import { parseConcept } from "../src/okf/frontmatter.js";
import { loadBundle } from "../src/okf/bundle.js";
import { checkConformance } from "../src/okf/conformance.js";
import { scaffoldBrain } from "../src/init/scaffold.js";
import { machineId } from "../src/instance/config.js";
import { doctor } from "../src/instance/doctor.js";
import { runAgent } from "../src/harness/run.js";
import { heartbeat } from "../src/harness/heartbeat.js";
import { FakeProvider } from "../src/providers/fake.js";
import { registerProvider } from "../src/providers/index.js";
import { main } from "../src/cli.js";

/**
 * Synced storage (v2.3.7): a brain in a OneDrive, SharePoint, Google Drive
 * or Dropbox folder instead of git. Sync clients do not merge; they keep
 * both versions as conflict copies, upload whatever they see mid-write, and
 * leave cloud-only placeholders. Each test pins one of those edges.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function brain(extra: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const root = await makeTree({
    "animamesh.config.json": JSON.stringify({ bundle: "bundle", storage: { kind: "synced", runner: machineId() }, ...config }),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    ...extra,
  });
  roots.push(root);
  return root;
}

describe("conflict copies and unsyncable names", () => {
  it("recognizes OneDrive, Google Drive and Dropbox conflict copies, and not ordinary names", () => {
    const names = new Set(["notes.md", "notes-ADAS-MBP.md", "plan.md", "plan (1).md", "deck.md", "deck-v2.md", "budget-r4.md", "budget.md", "x (1).md"]);
    expect(conflictCopyReason("notes-ADAS-MBP.md", names)).toMatch(/OneDrive conflict copy of notes.md \(from ADAS-MBP\)/);
    expect(conflictCopyReason("plan (1).md", names)).toMatch(/duplicate of plan.md/);
    expect(conflictCopyReason("deck (Ada's conflicted copy 2026-10-27).md", names)).toMatch(/Dropbox/);
    expect(conflictCopyReason("deck-v2.md", names)).toBeNull(); // a real version name, lower case
    expect(conflictCopyReason("budget-r4.md", names)).toBeNull();
    expect(conflictCopyReason("x (1).md", names)).toBeNull(); // no original beside it
    expect(conflictCopies(["a/notes.md", "a/notes-DESKTOP-7Q2.md", "b/notes-DESKTOP-7Q2.md"]).map((c) => c.path)).toEqual(["a/notes-DESKTOP-7Q2.md"]);
  });

  it("flags names Windows, OneDrive and SharePoint refuse, case-only twins, and long paths", () => {
    const problems = portabilityIssues([
      "facts/q3: results.md",
      "facts/draft..md".replace("..md", "."),
      "ops/CON.md",
      "ops/~$focus.md",
      "people/Sam.md",
      "people/sam.md",
      `deep/${"x".repeat(210)}.md`,
      "events/2026/20261027-fine-name.md",
    ]).map((p) => p.path);
    expect(problems).toEqual([
      "facts/q3: results.md",
      "facts/draft.",
      "ops/CON.md",
      "ops/~$focus.md",
      "people/sam.md",
      `deep/${"x".repeat(210)}.md`,
    ]);
  });

  it("machine ids are file-name safe", () => {
    expect(sanitizeWriter("Adas-MacBook-Pro.local")).toBe("adas-macbook-pro");
    expect(sanitizeWriter("DESKTOP 7Q2!")).toBe("desktop-7q2");
    expect(sanitizeWriter("...")).toBe("machine");
  });

  it("validate warns on a conflict copy and an unsyncable name in the bundle", async () => {
    const root = await brain({
      "bundle/facts/identity.md": concept("fact", { title: "Identity" }, "# Identity\n"),
      "bundle/facts/identity-LAPTOP2.md": concept("fact", { title: "Identity" }, "# Identity (older)\n"),
      "bundle/facts/q3: results.md": concept("fact", {}, "# Q3\n"),
    });
    const rules = checkConformance(await loadBundle(path.join(root, "bundle")), "animamesh").issues.map((i) => [i.rule, i.path]);
    expect(rules).toContainEqual(["storage/conflict-copy", "facts/identity-LAPTOP2.md"]);
    expect(rules).toContainEqual(["storage/portable-name", "facts/q3: results.md"]);
  });
});

describe("the ledger in a synced folder", () => {
  it("each machine appends to its own shard; a read merges every shard and conflict copy, once, in time order", async () => {
    const dir = path.join(tmpdir(), `am-ledger-${Date.now()}`);
    roots.push(dir);
    const base = path.join(dir, "actions.jsonl");
    const e = (ts: string, action: string) => ({ ts, runId: "r", agent: "a", action, type: "report" });
    new Ledger(base, { writer: "laptop" }).append(e("2026-10-27T10:00:00Z", "from-laptop"));
    new Ledger(base, { writer: "desktop" }).append(e("2026-10-27T09:00:00Z", "from-desktop"));
    new Ledger(base, { writer: "desktop" }).append(e("2026-10-27T11:00:00Z", "from-desktop-later"));
    // A conflict copy the client made of the desktop shard: same lines plus one.
    const desktop = await readFile(path.join(dir, "actions.desktop.jsonl"), "utf8");
    await writeFile(path.join(dir, "actions.desktop-LAPTOP.jsonl"), desktop + JSON.stringify(e("2026-10-27T12:00:00Z", "only-in-copy")) + "\n");

    expect((await readdir(dir)).sort()).toEqual(["actions.desktop-LAPTOP.jsonl", "actions.desktop.jsonl", "actions.laptop.jsonl"]);
    const actions = new Ledger(base).read().map((x) => x.action);
    expect(actions).toEqual(["from-desktop", "from-laptop", "from-desktop-later", "only-in-copy"]);
    expect(new Ledger(base).integrity()).toMatchObject({ ok: true, lineCount: 6 });
  });

  it("a run in a synced brain writes this machine's shard, never the shared base file", async () => {
    const root = await brain({
      "bundle/agents/hub.md": concept("agent", { name: "hub", title: "Hub", level: "L1", model: "m", harness: "fake" }, "Work."),
    });
    await runAgent({ instanceRoot: root, agentName: "hub", provider: new FakeProvider(), runId: "run-shard" });
    expect(await readdir(path.join(root, "ledger"))).toEqual([`actions.${machineId()}.jsonl`]);
    expect((await new FsInstanceStore(root).readLedger()).some((x) => x.runId === "run-shard")).toBe(true);
  });
});

describe("files a sync client can see mid-write or cannot download", () => {
  it("writes are atomic: no temp file is left beside the result", async () => {
    const root = await brain();
    const store = new FsInstanceStore(root);
    await store.writeFile("bundle/ops/schedule.md", "# Schedule\n");
    await store.writeReport("2026-10-27-hub-aaaa.md", "# Report\n");
    expect(await readdir(path.join(root, "bundle/ops"))).toEqual(["schedule.md"]);
    expect(await readdir(path.join(root, "reports"))).toEqual(["2026-10-27-hub-aaaa.md"]);
  });

  it("an unreadable file is an error, never 'missing' (a placeholder must not read as an absent fact)", async () => {
    const root = await brain({ "bundle/ops/calendar.md": "# Calendar\n" });
    const store = new FsInstanceStore(root);
    expect(await store.readOptional("bundle/ops/nope.md")).toBeNull();
    await chmod(path.join(root, "bundle/ops/calendar.md"), 0o000);
    try {
      await expect(store.readOptional("bundle/ops/calendar.md")).rejects.toThrow(/available offline/);
    } finally {
      await chmod(path.join(root, "bundle/ops/calendar.md"), 0o644);
    }
  });

  it("a byte-order mark does not hide the frontmatter", () => {
    expect(parseConcept("﻿---\ntype: fact\n---\n\n# X\n")?.frontmatter.type).toBe("fact");
  });

  it("a conflict copy of an approval never undoes its decision", async () => {
    const root = await brain();
    const store = new ApprovalStore(path.join(root, "approvals"));
    const req = store.request({ actionType: "filing", summary: "file it", requestedBy: "hub" });
    const pendingText = await readFile(path.join(root, "approvals", `${req.id}.json`), "utf8");
    store.decide(req.id, "approved", "principal");
    await writeFile(path.join(root, "approvals", `${req.id}-LAPTOP.json`), pendingText);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("approved");
  });
});

describe("one runner, and the hub hears about conflicts", () => {
  it("heartbeat refuses on a machine that is not the runner, unless forced or a dry run", async () => {
    const root = await brain({}, { storage: { kind: "synced", runner: "some-other-machine" } });
    const lines: string[] = [];
    const io = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) };
    expect(await main(["heartbeat", "--instance", root], io)).toBe(2);
    expect(lines.join("\n")).toContain('runner is "some-other-machine"');
    expect(await main(["heartbeat", "--instance", root, "--dry-run"], io)).toBe(0);
    expect(await main(["heartbeat", "--instance", root, "--force", "--no-deliver"], io)).toBe(0);
  });

  it("a conflict copy in the bundle reaches the hub's prompt as a storage note", async () => {
    const root = await brain({
      "bundle/agents/chief-of-staff.md": concept("agent", { name: "chief-of-staff", title: "Hub", level: "L1", model: "m", harness: "fake", heartbeat: "daily" }, "Brief."),
      "bundle/facts/identity.md": concept("fact", {}, "# Identity\n"),
      "bundle/facts/identity (1).md": concept("fact", {}, "# Identity, other machine\n"),
      "ledger/.keep": "",
    });
    const provider = new FakeProvider();
    registerProvider(provider, "fake");
    try {
      await heartbeat({ instanceRoot: root });
    } finally {
      registerProvider(new FakeProvider(), "fake");
    }
    expect(provider.calls[0]!.prompt).toContain("## Storage notes for this beat");
    expect(provider.calls[0]!.prompt).toContain("facts/identity (1).md: duplicate of identity.md");
  });
});

describe("init --storage synced and doctor", () => {
  it("scaffolds a synced brain with this machine as runner and the synced-folder rules", async () => {
    const root = path.join(tmpdir(), `am-synced-${Date.now()}`);
    roots.push(root);
    await scaffoldBrain(root, { orgName: "Acme", principalName: "Sam", agents: [], storage: { kind: "synced", provider: "onedrive" }, localOnly: true, now: "2026-10-27T12:00:00Z" });
    const config = JSON.parse(await readFile(path.join(root, "animamesh.config.json"), "utf8"));
    expect(config.storage).toEqual({ kind: "synced", provider: "onedrive", runner: machineId() });
    const claude = await readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(claude).toContain("## Synced folder, not git");
    expect(claude).toContain("Never move or share this folder outside the drive");
    expect((await doctor(root)).ok).toBe(true);
  });

  it("finds what must not sync, conflict copies and bad names anywhere in the brain", async () => {
    const root = await brain({
      "bundle/facts/a.md": concept("fact", {}, "# A\n"),
      "bundle/facts/a-DESKTOP9.md": concept("fact", {}, "# A\n"),
      "reports/q3: wrap.md": "# x\n",
      ".env.local": "TOKEN=x\n",
      "drafts/~$deck.md": "",
    });
    await mkdir(path.join(root, "cloud/node_modules/pkg"), { recursive: true });
    const result = await doctor(root);
    expect(result.ok).toBe(false);
    const errors = result.findings.filter((f) => f.level === "error").map((f) => f.message).join("\n");
    expect(errors).toContain("cloud/node_modules/");
    expect(errors).toContain(".env.local");
    expect(errors).toContain("~$deck.md");
    expect(errors).toContain("bundle/facts/a-DESKTOP9.md");
    expect(errors).toContain("reports/q3: wrap.md");
  });
});
