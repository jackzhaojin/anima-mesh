import { readdirSync, readFileSync } from "node:fs";
import { writeFileAtomic, isMissing, unreadable } from "./atomic.js";
import * as path from "node:path";
import { loadBundle, type Bundle } from "../okf/bundle.js";
import { Ledger, type LedgerEntry } from "../ledger/ledger.js";
import { ApprovalStore, type ApprovalRecord, type ApprovalStatus } from "../gates/approvals.js";
import { loadInstance, type InstanceConfig, type ResolvedInstance } from "./config.js";
import { loadInstanceEnv } from "./env.js";
import type { InstanceStore } from "./store.js";

/**
 * The laptop-era behavior, extracted verbatim behind the seam: immediate
 * writes, flush is a no-op. Node-only — never import from workers/ code.
 */
export class FsInstanceStore implements InstanceStore {
  readonly instance: ResolvedInstance;
  readonly root: string;
  readonly bundleDir: string;
  private readonly ledger: Ledger;
  private readonly approvals: ApprovalStore;

  constructor(instanceRoot: string) {
    this.instance = loadInstance(instanceRoot);
    this.root = this.instance.root;
    this.bundleDir = this.instance.bundleDir;
    this.ledger = new Ledger(this.instance.ledgerFile, { writer: this.instance.ledgerWriter });
    this.approvals = new ApprovalStore(this.instance.approvalsDir);
  }

  async loadConfig(): Promise<InstanceConfig> {
    return this.instance.config;
  }

  async loadBundle(): Promise<Bundle> {
    return loadBundle(this.bundleDir);
  }

  // Only "does not exist" reads as absent (v2.3.7). Any other failure - a
  // cloud-only placeholder a sync client could not fetch, a permission
  // error - is loud: an agent must never be told a fact is missing when it
  // is merely not on this machine.
  async readOptional(relPath: string): Promise<string | null> {
    const abs = path.join(this.root, relPath);
    try {
      return readFileSync(abs, "utf8");
    } catch (err) {
      if (isMissing(err) || (err as { code?: string }).code === "EISDIR") return null;
      throw unreadable(abs, err);
    }
  }

  async listFiles(relDir: string): Promise<string[]> {
    const abs = path.join(this.root, relDir);
    try {
      return readdirSync(abs, { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.split(path.sep).join("/"))
        .sort();
    } catch (err) {
      if (isMissing(err)) return [];
      throw unreadable(abs, err);
    }
  }

  async listReports(): Promise<string[]> {
    try {
      return readdirSync(this.instance.reportsDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch (err) {
      if (isMissing(err)) return [];
      throw unreadable(this.instance.reportsDir, err);
    }
  }

  async readReport(name: string): Promise<string> {
    return readFileSync(path.join(this.instance.reportsDir, name), "utf8");
  }

  async writeReport(name: string, content: string): Promise<void> {
    writeFileAtomic(path.join(this.instance.reportsDir, name), content);
  }

  reportPath(name: string): string {
    return path.join(this.instance.reportsDir, name);
  }

  async readLedger(): Promise<LedgerEntry[]> {
    return this.ledger.read();
  }

  async appendLedger(entry: LedgerEntry): Promise<void> {
    this.ledger.append(entry);
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    writeFileAtomic(path.join(this.root, relPath), content);
  }

  async listApprovals(status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    return this.approvals.list(status);
  }

  async getApproval(id: string): Promise<ApprovalRecord | undefined> {
    return this.approvals.get(id);
  }

  instanceEnv(): Record<string, string> {
    return loadInstanceEnv(this.root);
  }

  /** Writes were immediate — nothing to persist. */
  async flush(_message: string): Promise<{ commitSha?: string }> {
    return {};
  }
}
