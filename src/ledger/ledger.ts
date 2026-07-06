import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Append-only JSONL action ledger — the tertiary seam. Every agent action is
 * one line; observability and audit assertions run against this file, never
 * against agent internals. Ported pattern from the continuous-agent lineage.
 */
export interface LedgerEntry {
  ts: string;
  runId: string;
  agent: string;
  /** Short verb-ish identifier, e.g. `report-written`, `calendar-checked`. */
  action: string;
  /** Action type in the constitution's vocabulary, e.g. `report`, `draft`, `money-movement`. */
  type: string;
  detail?: unknown;
  /** True when `type` is constitution-gated; requires approvalId. */
  gated?: boolean;
  approvalId?: string;
}

export interface LedgerIntegrity {
  ok: boolean;
  lineCount: number;
  badLines: Array<{ line: number; error: string }>;
}

export class Ledger {
  constructor(readonly filePath: string) {}

  /** Append one entry. Creates the parent dir/file on first use; never truncates. */
  append(entry: LedgerEntry): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
  }

  read(): LedgerEntry[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf8");
    const entries: LedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      entries.push(JSON.parse(line) as LedgerEntry);
    }
    return entries;
  }

  /** Non-throwing structural check: every non-empty line is valid JSON. */
  integrity(): LedgerIntegrity {
    if (!existsSync(this.filePath)) return { ok: true, lineCount: 0, badLines: [] };
    const raw = readFileSync(this.filePath, "utf8");
    const badLines: Array<{ line: number; error: string }> = [];
    let lineCount = 0;
    raw.split("\n").forEach((line, idx) => {
      if (!line.trim()) return;
      lineCount++;
      try {
        JSON.parse(line);
      } catch (err) {
        badLines.push({ line: idx + 1, error: String(err) });
      }
    });
    return { ok: badLines.length === 0, lineCount, badLines };
  }

  entriesForRun(runId: string): LedgerEntry[] {
    return this.read().filter((e) => e.runId === runId);
  }
}

/**
 * Ledger-completeness assertion (testing seam c): every action the run
 * declared must appear in the ledger under that runId.
 */
export function assertRunLogged(
  ledger: Ledger,
  runId: string,
  declaredActions: string[],
): { ok: boolean; missing: string[] } {
  const logged = new Set(ledger.entriesForRun(runId).map((e) => e.action));
  const missing = declaredActions.filter((a) => !logged.has(a));
  return { ok: missing.length === 0, missing };
}
