import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { loadInstance, machineId } from "./config.js";
import { writeFileAtomic } from "./atomic.js";
import { conflictCopies, portabilityIssues, sanitizeWriter } from "./storage-core.js";
import { Ledger } from "../ledger/ledger.js";

/**
 * `anima-mesh doctor` (v2.3.7): is this brain's folder healthy where it
 * lives? Most of it matters for a brain in a synced folder (OneDrive,
 * SharePoint, Google Drive, Dropbox), and all of it is safe on git:
 *
 * - conflict copies anywhere in the brain, and names that will not sync;
 * - every file readable now (a cloud-only placeholder that cannot download
 *   fails here, not mid-beat), and the folder writable atomically;
 * - things that must not live in a synced folder: node_modules and other
 *   symlink trees, a .git directory, .env secrets, Office lock files;
 * - the storage kind matching where the folder actually is, the runner
 *   machine, and the ledger's shards.
 */

export interface DoctorFinding {
  level: "ok" | "warn" | "error";
  check: string;
  message: string;
}

export interface DoctorResult {
  ok: boolean;
  root: string;
  findings: DoctorFinding[];
}

const SYNC_MARKERS: Array<[RegExp, string]> = [
  [/[\\/]Library[\\/]CloudStorage[\\/]OneDrive/i, "onedrive"],
  [/[\\/]OneDrive( - [^\\/]+)?[\\/]/i, "onedrive"],
  [/[\\/]Library[\\/]CloudStorage[\\/]GoogleDrive/i, "google-drive"],
  [/[\\/](Google Drive|My Drive|Shared drives)[\\/]/i, "google-drive"],
  [/[\\/](Library[\\/]CloudStorage[\\/])?Dropbox/i, "dropbox"],
  [/[\\/]SharePoint[\\/]/i, "onedrive"],
];

/** The sync provider a path sits under, judged by its folder names, or null. */
export function syncProviderOf(absPath: string): string | null {
  for (const [re, provider] of SYNC_MARKERS) if (re.test(absPath + path.sep)) return provider;
  return null;
}

const NEVER_SYNC_DIRS = new Set(["node_modules", ".pnpm-store", ".wrangler", "dist", ".venv", "__pycache__"]);

export async function doctor(instanceRoot: string): Promise<DoctorResult> {
  const instance = loadInstance(instanceRoot);
  const { root, config } = instance;
  const findings: DoctorFinding[] = [];
  const add = (level: DoctorFinding["level"], check: string, message: string) => findings.push({ level, check, message });
  const synced = config.storage?.kind === "synced";

  // ── where it lives ──────────────────────────────────────────────────────
  const provider = syncProviderOf(root);
  if (provider && !synced) {
    add("warn", "storage", `the folder looks like it is in ${provider}, but storage.kind is not "synced"; set it so each machine keeps its own ledger shard and beats have one runner`);
  } else if (synced) {
    add("ok", "storage", `synced storage${config.storage?.provider ? ` (${config.storage.provider})` : ""}${provider ? `, folder is in ${provider}` : ""}`);
  } else {
    add("ok", "storage", "git storage");
  }
  if (synced) {
    const runner = config.storage?.runner;
    if (!runner) add("warn", "runner", `no storage.runner: name the one machine that runs heartbeats (this one is "${machineId()}")`);
    else add("ok", "runner", sanitizeWriter(runner) === machineId() ? `this machine (${machineId()}) is the runner` : `runner is "${runner}"; this machine is "${machineId()}" (heartbeats run there)`);
    if (!process.env.ANIMAMESH_WRITER) {
      add("warn", "machine-id", `this machine's id "${machineId()}" comes from its host name; set ANIMAMESH_WRITER in your shell profile so it never changes`);
    }
  }

  // ── walk the whole brain once ───────────────────────────────────────────
  const files: string[] = [];
  const junk: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      add("error", "readable", `cannot list ${path.relative(root, dir) || "."}: ${(err as { code?: string }).code ?? String(err)}`);
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (e.name === ".DS_Store" || e.name === "desktop.ini" || e.name === "Icon\r") continue;
      if (e.isSymbolicLink()) {
        if (synced) junk.push(`${rel} (symlink: sync clients copy or drop these)`);
        continue;
      }
      if (e.isDirectory()) {
        if (e.name === ".git") {
          if (synced) junk.push(`${rel} (a git repository inside a synced folder corrupts when two machines sync it)`);
          continue;
        }
        if (NEVER_SYNC_DIRS.has(e.name)) {
          // In git these are ignored by .gitignore; in a synced folder nothing ignores them.
          if (synced) junk.push(`${rel}/ (build or dependency output: thousands of files and symlinks; keep it outside the brain)`);
          continue;
        }
        walk(abs);
      } else {
        if (e.name.startsWith("~$")) junk.push(`${rel} (an Office lock file: someone has it open, or it was left behind)`);
        else if (synced && /^\.env(\..*)?$/.test(e.name)) junk.push(`${rel} (secrets in a synced folder reach every machine and the drive's cloud; keep them in your shell environment)`);
        else if (/\.tmp$/.test(e.name) && e.name.startsWith(".")) junk.push(`${rel} (a temp file left by an interrupted write; safe to delete)`);
        files.push(rel);
      }
    }
  };
  walk(root);
  if (junk.length === 0) add("ok", "contents", "nothing in the brain that must not sync");
  for (const j of junk) add(synced ? "error" : "warn", "contents", j);

  // ── every file readable now ─────────────────────────────────────────────
  const started = Date.now();
  let unreadable = 0;
  for (const rel of files) {
    try {
      readFileSync(path.join(root, rel));
    } catch (err) {
      unreadable++;
      add("error", "readable", `${rel}: ${(err as { code?: string }).code ?? String(err)} (make the folder available offline)`);
    }
  }
  if (unreadable === 0) add("ok", "readable", `${files.length} files read in ${Date.now() - started} ms`);

  // ── writable, atomically ────────────────────────────────────────────────
  const probe = path.join(instance.reportsDir, ".doctor-probe");
  try {
    writeFileAtomic(probe, "probe\n");
    rmSync(probe, { force: true });
    add("ok", "writable", "reports/ accepts an atomic write");
  } catch (err) {
    add("error", "writable", `cannot write in reports/: ${(err as { code?: string }).code ?? String(err)}`);
  }

  // ── conflict copies and names that will not sync, brain-wide ────────────
  const conflicts = conflictCopies(files);
  for (const c of conflicts) add("error", "conflicts", `${c.path}: ${c.reason}; merge it into the original, then delete it`);
  if (conflicts.length === 0) add("ok", "conflicts", "no conflict copies");
  const names = portabilityIssues(files);
  for (const n of names) add(synced ? "error" : "warn", "names", `${n.path}: ${n.problem}`);
  if (names.length === 0) add("ok", "names", "every name is valid on Windows, OneDrive, SharePoint and Google Drive");

  // ── the ledger ──────────────────────────────────────────────────────────
  const ledger = new Ledger(instance.ledgerFile, { writer: instance.ledgerWriter });
  const shards = ledger.files().map((f) => path.relative(root, f).split(path.sep).join("/"));
  const integrity = ledger.integrity();
  if (!integrity.ok) {
    for (const b of integrity.badLines.slice(0, 5)) add("error", "ledger", `line ${b.line}: ${b.error}`);
  } else {
    add("ok", "ledger", `${integrity.lineCount} entries across ${shards.length} file(s)${shards.length > 1 ? `: ${shards.join(", ")}` : ""}${synced ? `; this machine appends to ${path.basename(ledger.appendPath)}` : ""}`);
  }
  if (!existsSync(instance.bundleDir) || !lstatSync(instance.bundleDir).isDirectory()) {
    add("error", "bundle", `no bundle directory at ${config.bundle}`);
  }

  return { ok: !findings.some((f) => f.level === "error"), root, findings };
}

export function formatDoctor(result: DoctorResult): string {
  const mark = { ok: "✓", warn: "!", error: "✗" } as const;
  const errors = result.findings.filter((f) => f.level === "error").length;
  const warns = result.findings.filter((f) => f.level === "warn").length;
  return [
    `doctor: ${result.root}`,
    ...result.findings.map((f) => `  ${mark[f.level]} ${f.check}: ${f.message}`),
    `${result.ok ? "HEALTHY" : "NEEDS ATTENTION"} - ${errors} error(s), ${warns} warning(s)`,
  ].join("\n");
}
