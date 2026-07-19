import { parseConcept } from "../okf/frontmatter.js";
import type { Bundle, Concept } from "../okf/bundle-core.js";
import type { LedgerEntry } from "../ledger/ledger.js";
import type { ApprovalRecord, ApprovalStatus } from "../gates/approvals.js";
import { DEFAULT_CONFIG, CONFIG_FILENAME, type InstanceConfig } from "./config-core.js";
import { parseTar, gunzip } from "./tar.js";
import type { InstanceStore } from "./store.js";

/**
 * The brain over HTTPS: one tarball read at a pinned commit, writes buffered
 * in memory, exactly one commit per flush() through the git data API —
 * blobs inlined into the tree, ref updated with force:false, ONE retry after
 * re-snapshotting if the ref moved, then a loud failure. The brain repo is
 * never force-pushed by a machine.
 *
 * Workers-safe: pure fetch + Web platform. Every request carries a
 * User-Agent — GitHub 403s UA-less calls and Workers' fetch sends none.
 */
export interface GitHubStoreOptions {
  /** "owner/name" */
  repo: string;
  /** Branch name. Default "main". */
  ref?: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Test seam. Default https://api.github.com */
  apiBase?: string;
  /** Commit identity. Default animamesh-cloud. */
  identity?: { name: string; email: string };
}

const DEFAULT_IDENTITY = {
  name: "animamesh-cloud",
  email: "animamesh-cloud@users.noreply.github.com",
};

interface Snapshot {
  /** Full commit sha the file map was taken at. */
  baseSha: string;
  /** repo-relative path → text content. */
  files: Map<string, string>;
}

export class GitHubInstanceStore implements InstanceStore {
  private readonly repo: string;
  private readonly ref: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly apiBase: string;
  private readonly identity: { name: string; email: string };

  private snapshot?: Snapshot;
  /** In-flight snapshot load — concurrent readers must share ONE fetch. */
  private loading?: Promise<Snapshot>;
  private config?: InstanceConfig;
  /** Full-file pending writes (reports, future concept edits). */
  private readonly pendingWrites = new Map<string, string>();
  /** Append-only pending lines (the ledger) — replayable onto a fresh base. */
  private readonly pendingAppends = new Map<string, string[]>();

  constructor(options: GitHubStoreOptions) {
    this.repo = options.repo;
    this.ref = options.ref ?? "main";
    this.token = options.token;
    // Wrapped, not aliased: calling a bare global `fetch` with `this` bound
    // to the store is an Illegal invocation on Workers.
    this.doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.identity = options.identity ?? DEFAULT_IDENTITY;
  }

  // ---- HTTP plumbing -------------------------------------------------------

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "animamesh",
    };
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.doFetch(`${this.apiBase}${path}`, {
      method,
      headers: { ...this.headers(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      const err = new Error(`github ${method} ${path} → HTTP ${res.status}: ${text}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return res.json();
  }

  // ---- snapshot ------------------------------------------------------------

  private async load(): Promise<Snapshot> {
    if (this.snapshot) return this.snapshot;
    // Memoize the PROMISE, not just the result: parallel readers (the web
    // dashboard fires listReports/readLedger/listApprovals concurrently)
    // must share one ref+tarball fetch, not race three.
    this.loading ??= this.doLoad();
    try {
      return await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async doLoad(): Promise<Snapshot> {
    const ref = await this.api("GET", `/repos/${this.repo}/git/ref/heads/${this.ref}`);
    const baseSha: string = ref.object.sha;
    const res = await this.doFetch(`${this.apiBase}/repos/${this.repo}/tarball/${baseSha}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`github tarball ${this.repo}@${baseSha.slice(0, 8)} → HTTP ${res.status}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.snapshot = { baseSha, files: parseTar(await gunzip(bytes)) };
    return this.snapshot;
  }

  /** Composed view of one path: pending write ?? base, plus pending appends. */
  private async readComposed(relPath: string): Promise<string | null> {
    const { files } = await this.load();
    let content = this.pendingWrites.get(relPath) ?? files.get(relPath) ?? null;
    const appends = this.pendingAppends.get(relPath);
    if (appends && appends.length > 0) {
      content = (content ?? "") + appends.join("");
    }
    return content;
  }

  private async loadConfigOnce(): Promise<InstanceConfig> {
    if (this.config) return this.config;
    const raw = await this.readComposed(CONFIG_FILENAME);
    if (raw === null) {
      throw new Error(`no ${CONFIG_FILENAME} found in ${this.repo}@${this.ref} — is this an AnimaMesh instance?`);
    }
    this.config = { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<InstanceConfig>) };
    return this.config;
  }

  // ---- InstanceStore -------------------------------------------------------

  async loadConfig(): Promise<InstanceConfig> {
    return this.loadConfigOnce();
  }

  async loadBundle(): Promise<Bundle> {
    const config = await this.loadConfigOnce();
    const { files } = await this.load();
    const prefix = `${config.bundle}/`;
    const concepts: Concept[] = [];
    // Read-your-writes: buffered concept edits (writeFile) overlay the
    // snapshot — verifiers reload the bundle after the harness writes.
    const paths = [...new Set([...files.keys(), ...this.pendingWrites.keys()])]
      .filter((p) => p.startsWith(prefix) && p.endsWith(".md"))
      .sort();
    for (const p of paths) {
      const raw = this.pendingWrites.get(p) ?? files.get(p)!;
      const relPath = p.slice(prefix.length);
      try {
        const parsed = parseConcept(raw);
        if (parsed === null) {
          concepts.push({ path: relPath, relPath, frontmatter: {}, body: raw, missingFrontmatter: true });
        } else {
          concepts.push({
            path: relPath,
            relPath,
            frontmatter: parsed.frontmatter,
            body: parsed.body,
            missingFrontmatter: false,
          });
        }
      } catch (err) {
        concepts.push({ path: relPath, relPath, frontmatter: {}, body: raw, missingFrontmatter: false, parseError: String(err) });
      }
    }
    return { root: config.bundle, concepts };
  }

  async readOptional(relPath: string): Promise<string | null> {
    return this.readComposed(relPath);
  }

  async listReports(): Promise<string[]> {
    const config = await this.loadConfigOnce();
    const { files } = await this.load();
    const prefix = `${config.reports}/`;
    const names = new Set<string>();
    for (const p of files.keys()) {
      if (p.startsWith(prefix) && p.endsWith(".md")) names.add(p.slice(prefix.length));
    }
    for (const p of this.pendingWrites.keys()) {
      if (p.startsWith(prefix) && p.endsWith(".md")) names.add(p.slice(prefix.length));
    }
    return [...names].filter((n) => !n.includes("/")).sort();
  }

  async readReport(name: string): Promise<string> {
    const config = await this.loadConfigOnce();
    const content = await this.readComposed(`${config.reports}/${name}`);
    if (content === null) throw new Error(`report not found: ${config.reports}/${name}`);
    return content;
  }

  async writeReport(name: string, content: string): Promise<void> {
    const config = await this.loadConfigOnce();
    this.pendingWrites.set(`${config.reports}/${name}`, content);
  }

  reportPath(name: string): string {
    return `${this.config?.reports ?? DEFAULT_CONFIG.reports}/${name}`;
  }

  async readLedger(): Promise<LedgerEntry[]> {
    const config = await this.loadConfigOnce();
    const raw = await this.readComposed(config.ledger);
    if (raw === null) return [];
    const entries: LedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      entries.push(JSON.parse(line) as LedgerEntry);
    }
    return entries;
  }

  async appendLedger(entry: LedgerEntry): Promise<void> {
    const config = await this.loadConfigOnce();
    const lines = this.pendingAppends.get(config.ledger) ?? [];
    lines.push(JSON.stringify(entry) + "\n");
    this.pendingAppends.set(config.ledger, lines);
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    this.pendingWrites.set(relPath, content);
  }

  async listApprovals(status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    const config = await this.loadConfigOnce();
    const { files } = await this.load();
    const prefix = `${config.approvals}/`;
    const records: ApprovalRecord[] = [];
    for (const [p, raw] of files) {
      if (!p.startsWith(prefix) || !p.endsWith(".json")) continue;
      records.push(JSON.parse(raw) as ApprovalRecord);
    }
    records.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    return status ? records.filter((r) => r.status === status) : records;
  }

  async getApproval(id: string): Promise<ApprovalRecord | undefined> {
    const config = await this.loadConfigOnce();
    const raw = await this.readComposed(`${config.approvals}/${id}.json`);
    return raw === null ? undefined : (JSON.parse(raw) as ApprovalRecord);
  }

  // ---- flush ---------------------------------------------------------------

  private dirtyPaths(): string[] {
    return [...new Set([...this.pendingWrites.keys(), ...this.pendingAppends.keys()])];
  }

  async flush(message: string): Promise<{ commitSha?: string }> {
    const paths = this.dirtyPaths();
    if (paths.length === 0) return {};

    let attempt = 0;
    for (;;) {
      // Re-check the ref: if someone moved the branch mid-beat, re-snapshot
      // and recompose — appends replay onto the NEW base content.
      const ref = await this.api("GET", `/repos/${this.repo}/git/ref/heads/${this.ref}`);
      const currentSha: string = ref.object.sha;
      if (!this.snapshot || this.snapshot.baseSha !== currentSha) {
        this.snapshot = undefined;
        await this.load();
      }

      const tree = [];
      for (const p of paths) {
        const content = await this.readComposed(p);
        tree.push({ path: p, mode: "100644", type: "blob", content: content ?? "" });
      }

      const baseSha = this.snapshot!.baseSha;
      const baseCommit = await this.api("GET", `/repos/${this.repo}/git/commits/${baseSha}`);
      const newTree = await this.api("POST", `/repos/${this.repo}/git/trees`, {
        base_tree: baseCommit.tree.sha,
        tree,
      });
      const now = new Date().toISOString();
      const commit = await this.api("POST", `/repos/${this.repo}/git/commits`, {
        message,
        tree: newTree.sha,
        parents: [baseSha],
        author: { ...this.identity, date: now },
        committer: { ...this.identity, date: now },
      });

      try {
        await this.api("PATCH", `/repos/${this.repo}/git/refs/heads/${this.ref}`, {
          sha: commit.sha,
          force: false, // the brain repo is never force-pushed by a machine
        });
      } catch (err) {
        const status = (err as Error & { status?: number }).status;
        if ((status === 422 || status === 409) && attempt === 0) {
          attempt++;
          this.snapshot = undefined; // lost the race — re-snapshot and retry once
          continue;
        }
        throw err;
      }

      // Success: fold pending state into the new base so the store stays usable.
      for (const p of paths) {
        const content = await this.readComposed(p);
        if (content !== null) this.snapshot!.files.set(p, content);
      }
      this.pendingWrites.clear();
      this.pendingAppends.clear();
      this.snapshot!.baseSha = commit.sha;
      return { commitSha: commit.sha };
    }
  }
}
