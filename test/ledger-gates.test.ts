import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Ledger, assertRunLogged } from "../src/ledger/ledger.js";
import { ApprovalStore } from "../src/gates/approvals.js";
import { GateViolation, assertActionAllowed, loadGatedTypes, DEFAULT_GATED_TYPES } from "../src/gates/gatekeeper.js";
import { canPerform, parseLevel, requiresGate } from "../src/autonomy/ladder.js";
import { verifyGateAssertions, verifyLedgerCompleteness, verifyExpectedOutputs } from "../src/harness/verifiers.js";
import { loadBundle } from "../src/okf/bundle.js";
import { makeTree, cleanup, concept, minimalOkfFiles } from "./helpers.js";

const roots: string[] = [];
async function tmp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "animamesh-lg-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function entry(overrides: Partial<Parameters<Ledger["append"]>[0]> = {}) {
  return {
    ts: "2026-07-05T12:00:00Z",
    runId: "run-1",
    agent: "test-agent",
    action: "did-thing",
    type: "report",
    ...overrides,
  };
}

describe("ledger", () => {
  it("appends and reads back JSONL", async () => {
    const ledger = new Ledger(path.join(await tmp(), "ledger", "actions.jsonl"));
    ledger.append(entry({ action: "a1" }));
    ledger.append(entry({ action: "a2", runId: "run-2" }));
    expect(ledger.read()).toHaveLength(2);
    expect(ledger.entriesForRun("run-2")).toHaveLength(1);
  });

  it("is append-only: existing lines survive later appends", async () => {
    const file = path.join(await tmp(), "actions.jsonl");
    const ledger = new Ledger(file);
    ledger.append(entry({ action: "first" }));
    const before = readFileSync(file, "utf8");
    ledger.append(entry({ action: "second" }));
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
  });

  it("detects corruption via integrity()", async () => {
    const file = path.join(await tmp(), "actions.jsonl");
    const ledger = new Ledger(file);
    ledger.append(entry());
    appendFileSync(file, "{not json\n");
    const integrity = ledger.integrity();
    expect(integrity.ok).toBe(false);
    expect(integrity.badLines).toHaveLength(1);
  });

  it("assertRunLogged reports missing declared actions", async () => {
    const ledger = new Ledger(path.join(await tmp(), "actions.jsonl"));
    ledger.append(entry({ action: "done" }));
    const result = assertRunLogged(ledger, "run-1", ["done", "not-done"]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["not-done"]);
  });
});

describe("approvals", () => {
  it("request → pending → approve, decisions are terminal", async () => {
    const store = new ApprovalStore(path.join(await tmp(), "approvals"));
    const rec = store.request({ actionType: "government-filing", summary: "File 1120", requestedBy: "compliance-ops" });
    expect(store.get(rec.id)!.status).toBe("pending");
    store.decide(rec.id, "approved", "founder");
    expect(store.get(rec.id)!.status).toBe("approved");
    expect(() => store.decide(rec.id, "denied", "founder")).toThrow(/already approved/);
  });

  it("lists by status in request order", async () => {
    const store = new ApprovalStore(path.join(await tmp(), "approvals"));
    const a = store.request({ actionType: "x", summary: "a", requestedBy: "t", now: "2026-01-01T00:00:00Z" });
    store.request({ actionType: "y", summary: "b", requestedBy: "t", now: "2026-01-02T00:00:00Z" });
    store.decide(a.id, "denied", "founder");
    expect(store.list()).toHaveLength(2);
    expect(store.list("pending")).toHaveLength(1);
    expect(store.list("denied")[0]!.summary).toBe("a");
  });
});

describe("autonomy ladder", () => {
  it("enforces the L1→L4 progression", () => {
    expect(canPerform("L1", "report")).toBe(true);
    expect(canPerform("L1", "draft")).toBe(false);
    expect(canPerform("L2", "draft")).toBe(true);
    expect(canPerform("L2", "reversible")).toBe(false);
    expect(canPerform("L3", "reversible")).toBe(true);
    expect(canPerform("L3", "external")).toBe(false);
    expect(canPerform("L4", "external")).toBe(true);
  });

  it("external stays gated even at L4", () => {
    expect(requiresGate("external")).toBe(true);
    expect(requiresGate("reversible")).toBe(false);
  });

  it("rejects invalid levels", () => {
    expect(() => parseLevel("L5")).toThrow(/invalid autonomy level/);
    expect(parseLevel("L2")).toBe("L2");
  });
});

describe("gatekeeper — safety is enforced in code, never in a prompt", () => {
  it("blocks actions above the agent's level", async () => {
    const approvals = new ApprovalStore(path.join(await tmp(), "approvals"));
    expect(() =>
      assertActionAllowed({
        agent: "rookie",
        level: "L1",
        category: "draft",
        actionType: "draft",
        gatedTypes: DEFAULT_GATED_TYPES,
        approvals,
      }),
    ).toThrow(GateViolation);
  });

  it("blocks gated action types without an approval — even at L4", async () => {
    const approvals = new ApprovalStore(path.join(await tmp(), "approvals"));
    expect(() =>
      assertActionAllowed({
        agent: "veteran",
        level: "L4",
        category: "external",
        actionType: "money-movement",
        gatedTypes: DEFAULT_GATED_TYPES,
        approvals,
      }),
    ).toThrow(/gated and no approvalId/);
  });

  it("blocks when the approval is pending or denied", async () => {
    const approvals = new ApprovalStore(path.join(await tmp(), "approvals"));
    const pending = approvals.request({ actionType: "money-movement", summary: "pay", requestedBy: "b" });
    expect(() =>
      assertActionAllowed({
        agent: "bookkeeper", level: "L4", category: "external", actionType: "money-movement",
        gatedTypes: DEFAULT_GATED_TYPES, approvals, approvalId: pending.id,
      }),
    ).toThrow(/pending, not approved/);
    approvals.decide(pending.id, "denied", "founder");
    expect(() =>
      assertActionAllowed({
        agent: "bookkeeper", level: "L4", category: "external", actionType: "money-movement",
        gatedTypes: DEFAULT_GATED_TYPES, approvals, approvalId: pending.id,
      }),
    ).toThrow(/denied, not approved/);
  });

  it("blocks approval/action type mismatch — approvals are per-action", async () => {
    const approvals = new ApprovalStore(path.join(await tmp(), "approvals"));
    const rec = approvals.request({ actionType: "external-publishing", summary: "post", requestedBy: "cos" });
    approvals.decide(rec.id, "approved", "founder");
    expect(() =>
      assertActionAllowed({
        agent: "cos", level: "L4", category: "external", actionType: "money-movement",
        gatedTypes: DEFAULT_GATED_TYPES, approvals, approvalId: rec.id,
      }),
    ).toThrow(/per-action/);
  });

  it("allows a gated action with a matching approved record", async () => {
    const approvals = new ApprovalStore(path.join(await tmp(), "approvals"));
    const rec = approvals.request({ actionType: "government-filing", summary: "file", requestedBy: "ops" });
    approvals.decide(rec.id, "approved", "founder");
    expect(() =>
      assertActionAllowed({
        agent: "ops", level: "L4", category: "external", actionType: "government-filing",
        gatedTypes: DEFAULT_GATED_TYPES, approvals, approvalId: rec.id,
      }),
    ).not.toThrow();
  });

  it("enforces the L3 whitelist for reversible actions", async () => {
    const approvals = new ApprovalStore(path.join(await tmp(), "approvals"));
    const base = {
      agent: "librarian", level: "L3" as const, category: "reversible" as const,
      gatedTypes: DEFAULT_GATED_TYPES, approvals,
    };
    expect(() => assertActionAllowed({ ...base, actionType: "repo-commit", whitelist: ["repo-commit"] })).not.toThrow();
    expect(() => assertActionAllowed({ ...base, actionType: "delete-everything", whitelist: ["repo-commit"] })).toThrow(/whitelist/);
  });

  it("loads gated types from the constitution as a union with the floor", async () => {
    const root = await makeTree({
      ...minimalOkfFiles(),
      "constitution.md":
        '---\ntype: constitution\nimmutable: true\ngated-actions: ["money-movement", "hiring"]\n---\n\n# C\n',
    });
    roots.push(root);
    const gated = loadGatedTypes(await loadBundle(root));
    expect(gated).toContain("hiring");
    for (const t of DEFAULT_GATED_TYPES) expect(gated).toContain(t);
  });
});

describe("verifiers", () => {
  it("gate-assertions flags gated ledger entries without approved records", async () => {
    const dir = await tmp();
    const ledger = new Ledger(path.join(dir, "actions.jsonl"));
    const approvals = new ApprovalStore(path.join(dir, "approvals"));
    ledger.append(entry({ action: "paid", type: "money-movement" }));
    const bad = verifyGateAssertions(ledger, approvals, DEFAULT_GATED_TYPES);
    expect(bad.ok).toBe(false);

    const rec = approvals.request({ actionType: "money-movement", summary: "pay", requestedBy: "b" });
    approvals.decide(rec.id, "approved", "founder");
    ledger.append(entry({ action: "paid-2", type: "money-movement", runId: "run-9", approvalId: rec.id }));
    const good = verifyGateAssertions(ledger, approvals, DEFAULT_GATED_TYPES, "run-9");
    expect(good.ok).toBe(true);
  });

  it("ledger-completeness fails on unlogged declared actions and corrupt files", async () => {
    const dir = await tmp();
    const file = path.join(dir, "actions.jsonl");
    const ledger = new Ledger(file);
    ledger.append(entry({ action: "logged" }));
    expect(verifyLedgerCompleteness(ledger, "run-1", ["logged"]).ok).toBe(true);
    expect(verifyLedgerCompleteness(ledger, "run-1", ["logged", "ghost"]).ok).toBe(false);
    appendFileSync(file, "garbage\n");
    expect(verifyLedgerCompleteness(ledger, "run-1", ["logged"]).details).toContain("corrupt");
  });

  it("expected-outputs requires existing non-empty artifacts", async () => {
    const dir = await tmp();
    const present = path.join(dir, "report.md");
    const empty = path.join(dir, "empty.md");
    writeFileSync(present, "content");
    writeFileSync(empty, "");
    expect(verifyExpectedOutputs([present]).ok).toBe(true);
    expect(verifyExpectedOutputs([present, empty]).ok).toBe(false);
    expect(verifyExpectedOutputs([path.join(dir, "ghost.md")]).ok).toBe(false);
  });
});
