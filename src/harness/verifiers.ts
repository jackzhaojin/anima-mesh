import { existsSync, statSync } from "node:fs";
import { loadBundle, type Bundle } from "../okf/bundle.js";
import { checkConformance, type ConformanceProfile, type ConformanceReport } from "../okf/conformance.js";
import { Ledger, assertRunLogged, type LedgerEntry } from "../ledger/ledger.js";
import type { ApprovalRecord, ApprovalStore } from "../gates/approvals.js";
import type { InstanceStore } from "../instance/store.js";

/**
 * Post-run verifiers — deterministic code, run in the harness after every
 * heartbeat (D5). They check declared outputs at the seams, never agent
 * internals:
 *   (a) repo diff  — expected artifacts exist
 *   (b) gates      — no gated ledger entry without a matching approved record
 *   (c) ledger     — every declared action was appended, file is intact
 *   (+) bundle conformance stays green after the run
 */
export interface VerifierResult {
  name: string;
  ok: boolean;
  details: string;
}

/** Pure assembly over an already-loaded bundle — store/Workers-safe. */
export function verifyConformanceBundle(
  bundle: Bundle,
  profile: ConformanceProfile = "animamesh",
): VerifierResult & { report: ConformanceReport } {
  const report = checkConformance(bundle, profile);
  const errors = report.issues.filter((i) => i.level === "error");
  return {
    name: "bundle-conformance",
    ok: report.ok,
    details: report.ok
      ? `${report.conceptCount} concepts conformant (${profile})`
      : errors.map((e) => `${e.rule}${e.path ? ` @ ${e.path}` : ""}: ${e.message}`).join("; "),
    report,
  };
}

export async function verifyConformance(
  bundleRoot: string,
  profile: ConformanceProfile = "animamesh",
): Promise<VerifierResult & { report: ConformanceReport }> {
  return verifyConformanceBundle(await loadBundle(bundleRoot), profile);
}

export function verifyExpectedOutputs(paths: string[]): VerifierResult {
  const missing = paths.filter((p) => !existsSync(p) || statSync(p).size === 0);
  return {
    name: "expected-outputs",
    ok: missing.length === 0,
    details: missing.length === 0
      ? `${paths.length} expected artifact(s) present and non-empty`
      : `missing or empty: ${missing.join(", ")}`,
  };
}

/** Store-aware variant: report names checked for existence + non-emptiness. */
export async function verifyExpectedOutputsStore(
  store: InstanceStore,
  reportNames: string[],
): Promise<VerifierResult> {
  const missing: string[] = [];
  for (const name of reportNames) {
    try {
      const content = await store.readReport(name);
      if (content.trim().length === 0) missing.push(store.reportPath(name));
    } catch {
      missing.push(store.reportPath(name));
    }
  }
  return {
    name: "expected-outputs",
    ok: missing.length === 0,
    details: missing.length === 0
      ? `${reportNames.length} expected artifact(s) present and non-empty`
      : `missing or empty: ${missing.join(", ")}`,
  };
}

/** Pure core over materialized entries + an approval lookup — store/Workers-safe. */
export function verifyGateEntries(
  entries: LedgerEntry[],
  getApproval: (id: string) => ApprovalRecord | undefined,
  gatedTypes: readonly string[],
): VerifierResult {
  const violations: string[] = [];
  for (const entry of entries) {
    const gated = entry.gated === true || gatedTypes.includes(entry.type);
    if (!gated) continue;
    if (!entry.approvalId) {
      violations.push(`${entry.action} (${entry.type}) has no approvalId`);
      continue;
    }
    const record = getApproval(entry.approvalId);
    if (!record) violations.push(`${entry.action}: approval ${entry.approvalId} missing`);
    else if (record.status !== "approved") violations.push(`${entry.action}: approval ${entry.approvalId} is ${record.status}`);
    else if (record.actionType !== entry.type) violations.push(`${entry.action}: approval is for '${record.actionType}', entry is '${entry.type}'`);
  }
  return {
    name: "gate-assertions",
    ok: violations.length === 0,
    details: violations.length === 0 ? `${entries.length} ledger entr(ies) clean` : violations.join("; "),
  };
}

export function verifyGateAssertions(
  ledger: Ledger,
  approvals: ApprovalStore,
  gatedTypes: readonly string[],
  runId?: string,
): VerifierResult {
  const entries = runId ? ledger.entriesForRun(runId) : ledger.read();
  return verifyGateEntries(entries, (id) => approvals.get(id), gatedTypes);
}

/** Store-aware variant of verifyGateAssertions. */
export async function verifyGateAssertionsStore(
  store: InstanceStore,
  gatedTypes: readonly string[],
  runId?: string,
): Promise<VerifierResult> {
  const all = await store.readLedger();
  const entries = runId ? all.filter((e) => e.runId === runId) : all;
  const approvals = new Map((await store.listApprovals()).map((r) => [r.id, r]));
  return verifyGateEntries(entries, (id) => approvals.get(id), gatedTypes);
}

export function verifyLedgerCompleteness(
  ledger: Ledger,
  runId: string,
  declaredActions: string[],
): VerifierResult {
  const integrity = ledger.integrity();
  if (!integrity.ok) {
    return {
      name: "ledger-completeness",
      ok: false,
      details: `ledger corrupt: ${integrity.badLines.map((b) => `line ${b.line}`).join(", ")}`,
    };
  }
  const { ok, missing } = assertRunLogged(ledger, runId, declaredActions);
  return {
    name: "ledger-completeness",
    ok,
    details: ok ? `all ${declaredActions.length} declared action(s) logged` : `unlogged: ${missing.join(", ")}`,
  };
}

/**
 * Store-aware variant. Structural integrity is the store's concern (a store
 * whose readLedger() throws fails here loudly, with the same verifier name).
 */
export async function verifyLedgerCompletenessStore(
  store: InstanceStore,
  runId: string,
  declaredActions: string[],
): Promise<VerifierResult> {
  let entries: LedgerEntry[];
  try {
    entries = await store.readLedger();
  } catch (err) {
    return {
      name: "ledger-completeness",
      ok: false,
      details: `ledger corrupt: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const logged = new Set(entries.filter((e) => e.runId === runId).map((e) => e.action));
  const missing = declaredActions.filter((a) => !logged.has(a));
  return {
    name: "ledger-completeness",
    ok: missing.length === 0,
    details:
      missing.length === 0
        ? `all ${declaredActions.length} declared action(s) logged`
        : `unlogged: ${missing.join(", ")}`,
  };
}

export function allOk(results: VerifierResult[]): boolean {
  return results.every((r) => r.ok);
}

export function formatResults(results: VerifierResult[]): string {
  return results.map((r) => `${r.ok ? "✓" : "✗"} ${r.name}: ${r.details}`).join("\n");
}
