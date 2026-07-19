import type { Bundle } from "../okf/bundle-core.js";
import type { LedgerEntry } from "../ledger/ledger.js";
import type { ApprovalRecord, ApprovalStatus } from "../gates/approvals.js";
import type { InstanceConfig } from "./config-core.js";

/**
 * The storage seam: everything the harness touches at run time, behind one
 * interface, so an instance can live on a local filesystem (laptop) or in a
 * git host reached over HTTPS (Workers). All methods are async — the remote
 * implementation demands it; the fs one just wraps sync calls.
 *
 * Contract notes implementations must honor:
 * - Read-your-writes: after appendLedger/writeReport, the corresponding
 *   reads include the new content even before flush — verifiers depend on it.
 * - flush() is a no-op for immediate-write stores; batched stores persist
 *   everything since the last flush as exactly ONE commit and never force-
 *   update a ref.
 *
 * This module is Workers-safe: type-only imports, no node built-ins.
 */
export interface InstanceStore {
  /** Absolute instance root when filesystem-backed; undefined for remote stores. */
  readonly root?: string;
  /** Absolute bundle dir when filesystem-backed (CLI harness cwd); undefined for remote stores. */
  readonly bundleDir?: string;

  /** Parsed animamesh.config.json (with DEFAULT_CONFIG merged). */
  loadConfig(): Promise<InstanceConfig>;
  /** Every markdown concept under the bundle root. */
  loadBundle(): Promise<Bundle>;
  /** Instance-root-relative read; null when absent (tolerant reads in buildPrompt). */
  readOptional(relPath: string): Promise<string | null>;

  /** Report filenames, sorted ascending. */
  listReports(): Promise<string[]>;
  readReport(name: string): Promise<string>;
  writeReport(name: string, content: string): Promise<void>;
  /** Display path for a report name: absolute on fs, instance-relative otherwise. */
  reportPath(name: string): string;

  readLedger(): Promise<LedgerEntry[]>;
  appendLedger(entry: LedgerEntry): Promise<void>;

  listApprovals(status?: ApprovalStatus): Promise<ApprovalRecord[]>;
  getApproval(id: string): Promise<ApprovalRecord | undefined>;

  /**
   * Instance-root-relative full-file write (mirror of readOptional) — the
   * harness's path for concept edits it is gated to make (e.g. the schedule
   * surface). Read-your-writes applies: loadBundle/readOptional must see the
   * new content before flush.
   */
  writeFile(relPath: string, content: string): Promise<void>;

  /** Instance-local env (.env/.env.local) when the store has one. */
  instanceEnv?(): Record<string, string>;

  /**
   * Persist everything buffered since the last flush.
   * Fs impl: no-op (writes were immediate). Batched impls: exactly one
   * commit; returns its sha; throws after one ref-conflict retry — never
   * force-pushes.
   */
  flush(message: string): Promise<{ commitSha?: string }>;
}
