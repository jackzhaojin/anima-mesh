import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { main } from "../src/cli.js";
import { ApprovalStore } from "../src/gates/approvals.js";
import { loadInstance } from "../src/instance/config.js";

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "animamesh-cli-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { log: (s: string) => out.push(s), error: (s: string) => err.push(s) },
    out: () => out.join("\n"),
    err: () => err.join("\n"),
  };
}

async function initInstance(dir: string): Promise<void> {
  const answers = path.join(path.dirname(dir), "answers.json");
  await writeFile(
    answers,
    JSON.stringify({
      orgName: "CLI Test Org",
      principalName: "Pat",
      personaName: "Vesper",
      agents: ["compliance-ops", "chief-of-staff", "inbound-triage"],
    }),
  );
  const c = capture();
  const code = await main(["init", dir, "--answers", answers], c.io);
  if (code !== 0) throw new Error(`init failed:\n${c.out()}\n${c.err()}`);
}

describe("cli", () => {
  it("help and unknown commands exit correctly", async () => {
    const c1 = capture();
    expect(await main(["help"], c1.io)).toBe(0);
    expect(c1.out()).toContain("anima-mesh");
    const c2 = capture();
    expect(await main(["frobnicate"], c2.io)).toBe(2);
    expect(c2.err()).toContain("unknown command");
    const c3 = capture();
    expect(await main([], c3.io)).toBe(2);
  });

  it("templates lists the shipped roster", async () => {
    const c = capture();
    expect(await main(["templates"], c.io)).toBe(0);
    expect(c.out()).toContain("compliance-ops");
    expect(c.out()).toContain("sales-qualification");
  });

  it("init --answers scaffolds a passing instance; validate agrees", async () => {
    const dir = path.join(await freshRoot(), "brain");
    await initInstance(dir);

    const v = capture();
    expect(await main(["validate", dir], v.io)).toBe(0);
    expect(v.out()).toContain("PASS");

    // bundle dir directly also validates
    const v2 = capture();
    expect(await main(["validate", path.join(dir, "bundle"), "--profile", "okf"], v2.io)).toBe(0);
  });

  it("validate fails (exit 1) on a broken bundle", async () => {
    const dir = path.join(await freshRoot(), "brain");
    await initInstance(dir);
    await writeFile(path.join(dir, "bundle", "rogue.md"), "# no frontmatter\n");
    const c = capture();
    expect(await main(["validate", dir], c.io)).toBe(1);
    expect(c.out()).toContain("FAIL");
  });

  it("init flags mode works without a file", async () => {
    const dir = path.join(await freshRoot(), "brain");
    const c = capture();
    const code = await main(
      ["init", dir, "--org", "Flag Org", "--principal", "Fran", "--agents", "bookkeeper,research-watch", "--harness", "fake", "--model", "test-m"],
      c.io,
    );
    expect(code).toBe(0);
    const instance = loadInstance(dir);
    expect(instance.config.identity!.principal.name).toBe("Fran");
  });

  it("gate list/approve/deny drive the approval store", async () => {
    const dir = path.join(await freshRoot(), "brain");
    await initInstance(dir);
    const store = new ApprovalStore(loadInstance(dir).approvalsDir);
    const a = store.request({ actionType: "government-filing", summary: "file the return", requestedBy: "compliance-ops" });
    const b = store.request({ actionType: "money-movement", summary: "pay the fee", requestedBy: "bookkeeper" });

    const list = capture();
    expect(await main(["gate", "list", "--instance", dir], list.io)).toBe(0);
    expect(list.out()).toContain("file the return");
    expect(list.out()).toContain("pay the fee");

    const approve = capture();
    expect(await main(["gate", "approve", a.id, "--instance", dir, "--by", "Pat"], approve.io)).toBe(0);
    expect(store.get(a.id)!.status).toBe("approved");
    expect(store.get(a.id)!.decidedBy).toBe("Pat");

    const deny = capture();
    expect(await main(["gate", "deny", b.id, "--instance", dir, "--by", "Pat", "--note", "not yet"], deny.io)).toBe(0);
    expect(store.get(b.id)!.status).toBe("denied");
    expect(store.get(b.id)!.note).toBe("not yet");
  });

  it("report summarizes agents, approvals, ledger", async () => {
    const dir = path.join(await freshRoot(), "brain");
    await initInstance(dir);
    const c = capture();
    expect(await main(["report", "--instance", dir], c.io)).toBe(0);
    expect(c.out()).toContain("compliance-ops [L1]");
    expect(c.out()).toContain("inbound-triage");
    expect(c.out()).toContain("commercial, dual-gated");
  });

  it("run surfaces missing agents as an error exit", async () => {
    const dir = path.join(await freshRoot(), "brain");
    await initInstance(dir);
    const c = capture();
    expect(await main(["run", "ghost", "--instance", dir], c.io)).toBe(1);
    expect(c.err()).toContain("agent 'ghost' not found");
  });
});
