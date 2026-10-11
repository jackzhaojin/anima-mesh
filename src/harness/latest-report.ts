import type { InstanceStore } from "../instance/store.js";

/**
 * The newest report an agent wrote - Workers-safe, shared by delivery and
 * the brain export (a linked brain's "latest brief").
 *
 * "Newest" comes from the ledger, not the filename: report names end in a
 * random run-id, so when an agent runs twice in one day the lexicographic
 * tail is a coin flip (2026-08-01: a manual beat re-delivered the
 * morning's stale brief instead of the run it had just completed). The
 * agent's last report-written entry is the recency record; name order
 * stays as the fallback for ledgerless instances.
 *
 * Direction artifacts (`<date>-<agent>.direction-<id>.md`) never match:
 * the agent name is followed by a dot there, not a hyphen.
 */
export async function newestReportName(store: InstanceStore, agent: string): Promise<string | undefined> {
  const candidates = (await store.listReports()).filter((f) => f.includes(`-${agent}-`));
  if (candidates.length === 0) return undefined;
  let newest: string | undefined;
  try {
    for (const entry of await store.readLedger()) {
      if (entry.agent !== agent || entry.action !== "report-written") continue;
      const name = (entry.detail as { path?: string } | undefined)?.path?.split("/").pop();
      if (name && candidates.includes(name)) newest = name;
    }
  } catch {
    // an unreadable ledger must not block the read - fall back to name order
  }
  return newest ?? candidates[candidates.length - 1];
}
