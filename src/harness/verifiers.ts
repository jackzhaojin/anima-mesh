import { existsSync, statSync } from "node:fs";
import { loadBundle } from "../okf/bundle.js";
import { checkConformance, type ConformanceProfile, type ConformanceReport } from "../okf/conformance.js";
import { Ledger, assertRunLogged } from "../ledger/ledger.js";
import type { ApprovalStore } from "../gates/approvals.js";

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

export async function verifyConformance(
  bundleRoot: string,
  profile: ConformanceProfile = "animamesh",
): Promise<VerifierResult & { report: ConformanceReport }> {
  const bundle = await loadBundle(bundleRoot);
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

export function verifyGateAssertions(
  ledger: Ledger,
  approvals: ApprovalStore,
  gatedTypes: readonly string[],
  runId?: string,
): VerifierResult {
  const entries = runId ? ledger.entriesForRun(runId) : ledger.read();
  const violations: string[] = [];
  for (const entry of entries) {
    const gated = entry.gated === true || gatedTypes.includes(entry.type);
    if (!gated) continue;
    if (!entry.approvalId) {
      violations.push(`${entry.action} (${entry.type}) has no approvalId`);
      continue;
    }
    const record = approvals.get(entry.approvalId);
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

export function allOk(results: VerifierResult[]): boolean {
  return results.every((r) => r.ok);
}

export function formatResults(results: VerifierResult[]): string {
  return results.map((r) => `${r.ok ? "✓" : "✗"} ${r.name}: ${r.details}`).join("\n");
}
