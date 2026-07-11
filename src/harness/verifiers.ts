import { existsSync, statSync } from "node:fs";
import { loadBundle } from "../okf/bundle.js";
import { diskLinkChecker } from "../okf/conformance-fs.js";
import type { ConformanceProfile, ConformanceReport } from "../okf/conformance.js";
import { Ledger, assertRunLogged } from "../ledger/ledger.js";
import type { ApprovalStore } from "../gates/approvals.js";
import { verifyConformanceBundle, verifyGateEntries, type VerifierResult } from "./verifiers-core.js";

export {
  verifyConformanceBundle,
  verifyExpectedOutputsStore,
  verifyGateEntries,
  verifyGateAssertionsStore,
  verifyLedgerCompletenessStore,
  allOk,
  formatResults,
  type VerifierResult,
} from "./verifiers-core.js";

/**
 * Filesystem wrappers over verifiers-core — the CLI-era API, Node-only.
 * R4 link checking keeps full disk fidelity here.
 */
export async function verifyConformance(
  bundleRoot: string,
  profile: ConformanceProfile = "animamesh",
): Promise<VerifierResult & { report: ConformanceReport }> {
  return verifyConformanceBundle(await loadBundle(bundleRoot), profile, { linkExists: diskLinkChecker });
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
