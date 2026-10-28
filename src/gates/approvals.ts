import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { writeFileAtomic } from "../instance/atomic.js";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

/**
 * File-based needs-you approval surface — the secondary seam. Every
 * consequential action passes through here; platform `waitForEvent`
 * can replace the storage later without changing the contract.
 */
export type ApprovalStatus = "pending" | "approved" | "denied";

export interface ApprovalRecord {
  id: string;
  actionType: string;
  summary: string;
  requestedBy: string;
  requestedAt: string;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

export class ApprovalStore {
  constructor(readonly dir: string) {}

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  request(input: { actionType: string; summary: string; requestedBy: string; now?: string }): ApprovalRecord {
    mkdirSync(this.dir, { recursive: true });
    const record: ApprovalRecord = {
      id: randomUUID(),
      actionType: input.actionType,
      summary: input.summary,
      requestedBy: input.requestedBy,
      requestedAt: input.now ?? new Date().toISOString(),
      status: "pending",
    };
    writeFileAtomic(this.fileFor(record.id), JSON.stringify(record, null, 2) + "\n");
    return record;
  }

  get(id: string): ApprovalRecord | undefined {
    const file = this.fileFor(id);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as ApprovalRecord;
  }

  /** Only the human side calls this. Decisions are terminal: no un-approving. */
  decide(id: string, decision: "approved" | "denied", decidedBy: string, note?: string): ApprovalRecord {
    const record = this.get(id);
    if (!record) throw new Error(`approval ${id} not found`);
    if (record.status !== "pending") throw new Error(`approval ${id} already ${record.status}`);
    const updated: ApprovalRecord = {
      ...record,
      status: decision,
      decidedBy,
      decidedAt: new Date().toISOString(),
      ...(note ? { note } : {}),
    };
    writeFileAtomic(this.fileFor(id), JSON.stringify(updated, null, 2) + "\n");
    return updated;
  }

  list(status?: ApprovalStatus): ApprovalRecord[] {
    if (!existsSync(this.dir)) return [];
    // A synced brain can hold a conflict copy of a record (one machine
    // approved while another still saw it pending): one record per id, and
    // a decision always outranks "pending" - decisions are terminal.
    const byId = new Map<string, ApprovalRecord>();
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      const r = JSON.parse(readFileSync(path.join(this.dir, file), "utf8")) as ApprovalRecord;
      const prior = byId.get(r.id);
      if (!prior || (prior.status === "pending" && r.status !== "pending")) byId.set(r.id, r);
    }
    const records = [...byId.values()];
    records.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    return status ? records.filter((r) => r.status === status) : records;
  }
}
