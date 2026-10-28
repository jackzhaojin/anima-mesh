import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
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

/**
 * The append-only ledger. In a git brain it is one file. In a synced brain
 * (v2.3.7) two machines appending to one file is how a sync client makes a
 * conflict copy and splits history, so each machine appends to its own
 * shard (`actions.<machine>.jsonl`) and a read merges the base file, every
 * shard, and any conflict copy the client made of them: exact duplicate
 * lines once, then all entries in timestamp order. Nothing is ever dropped
 * or rewritten.
 */
export class Ledger {
  constructor(
    readonly filePath: string,
    readonly options: { writer?: string } = {},
  ) {}

  /** Where this machine appends: the base file, or its own shard in a synced brain. */
  get appendPath(): string {
    const { writer } = this.options;
    if (!writer) return this.filePath;
    const ext = path.extname(this.filePath) || ".jsonl";
    return path.join(path.dirname(this.filePath), `${path.basename(this.filePath, ext)}.${writer}${ext}`);
  }

  /** Append one entry. Creates the parent dir/file on first use; never truncates. */
  append(entry: LedgerEntry): void {
    mkdirSync(path.dirname(this.appendPath), { recursive: true });
    appendFileSync(this.appendPath, JSON.stringify(entry) + "\n", "utf8");
  }

  /** The base file plus every shard or conflict copy of it, base first. */
  files(): string[] {
    const dir = path.dirname(this.filePath);
    const ext = path.extname(this.filePath) || ".jsonl";
    const stem = path.basename(this.filePath, ext);
    const out = existsSync(this.filePath) ? [this.filePath] : [];
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      if (abs !== this.filePath && name.startsWith(stem) && name.endsWith(ext) && !name.startsWith(".")) out.push(abs);
    }
    return out;
  }

  read(): LedgerEntry[] {
    const files = this.files();
    const seen = new Set<string>();
    const entries: LedgerEntry[] = [];
    for (const file of files) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        entries.push(JSON.parse(trimmed) as LedgerEntry);
      }
    }
    // One file keeps its append order exactly; several interleave by time
    // (stable, so entries sharing a timestamp keep their file order).
    if (files.length > 1) entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return entries;
  }

  /** Non-throwing structural check: every non-empty line of every file is valid JSON. */
  integrity(): LedgerIntegrity {
    const badLines: Array<{ line: number; error: string }> = [];
    let lineCount = 0;
    for (const file of this.files()) {
      const many = this.files().length > 1;
      readFileSync(file, "utf8").split("\n").forEach((line, idx) => {
        if (!line.trim()) return;
        lineCount++;
        try {
          JSON.parse(line);
        } catch (err) {
          badLines.push({ line: idx + 1, error: many ? `${path.basename(file)}: ${String(err)}` : String(err) });
        }
      });
    }
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
