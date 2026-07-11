import { describe, it, expect, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { GitHubInstanceStore } from "../src/instance/store-github.js";
import { parseTar, gunzip } from "../src/instance/tar.js";
import { githubToken } from "../src/instance/github-auth.js";
import { runAgent } from "../src/harness/run.js";
import { FakeProvider } from "../src/providers/fake.js";
import { concept } from "./helpers.js";

// ---- fixture tarball (built in-test; checked-in binaries age poorly) -------

function tarEntry(name: string, content: string): Uint8Array {
  const data = new TextEncoder().encode(content);
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name), 0); // name (≤100 here)
  header.set(enc.encode("0000644\0"), 100); // mode
  header.set(enc.encode("0000000\0"), 108); // uid
  header.set(enc.encode("0000000\0"), 116); // gid
  header.set(enc.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124); // size
  header.set(enc.encode("00000000000\0"), 136); // mtime
  header.set(enc.encode("        "), 148); // checksum placeholder (8 spaces)
  header[156] = 0x30; // typeflag '0' = file
  header.set(enc.encode("ustar\0"), 257);
  header.set(enc.encode("00"), 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  const padded = new Uint8Array(512 + Math.ceil(data.length / 512) * 512);
  padded.set(header, 0);
  padded.set(data, 512);
  return padded;
}

function buildTarball(files: Record<string, string>, topDir = "owner-brain-abc1234"): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [rel, content] of Object.entries(files)) {
    parts.push(tarEntry(`${topDir}/${rel}`, content));
  }
  parts.push(new Uint8Array(1024)); // two zero blocks end the archive
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return gzipSync(out);
}

const BRAIN_FILES: Record<string, string> = {
  "animamesh.config.json": JSON.stringify({ bundle: "bundle" }),
  "bundle/index.md": concept("index", {}, "# Index\n"),
  "bundle/log.md": concept("log", {}, "# Log\n"),
  "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
  "bundle/ops/calendar.md": concept("calendar", {}, "# Calendar\n\n- 2026-09-15: annual return\n"),
  "bundle/agents/scout.md": concept(
    "agent",
    { name: "scout", title: "Scout", level: "L1", model: "test-model", harness: "fake" },
    "Wake daily, report what needs the principal.",
  ),
  "ledger/actions.jsonl":
    JSON.stringify({ ts: "2026-01-01T00:00:00Z", runId: "old", agent: "scout", action: "run-completed", type: "report" }) +
    "\n",
  "reports/2026-01-01-scout-old00000.md": "---\ntype: report\n---\n\nold report\n",
  "approvals/appr-1.json": JSON.stringify({
    id: "appr-1",
    actionType: "money-movement",
    summary: "test approval",
    requestedBy: "scout",
    requestedAt: "2026-01-01T00:00:00Z",
    status: "pending",
  }),
};

const BASE_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

/**
 * A scripted GitHub API: routes the store's calls against the fixture.
 * Records every request for assertions.
 */
function githubMock(opts: { files?: Record<string, string>; refSha?: () => string; patchRef?: (call: number) => Response } = {}) {
  const files = opts.files ?? BRAIN_FILES;
  const tarball = buildTarball(files);
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: any }> = [];
  let patchCount = 0;

  const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, headers, body });

    if (url.includes("/git/ref/heads/")) {
      return Response.json({ object: { sha: opts.refSha ? opts.refSha() : BASE_SHA } });
    }
    if (url.includes("/tarball/")) {
      return new Response(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength) as ArrayBuffer);
    }
    if (url.includes("/git/commits/") && method === "GET") {
      return Response.json({ tree: { sha: "tree-base" } });
    }
    if (url.endsWith("/git/trees") && method === "POST") {
      return Response.json({ sha: "tree-new" });
    }
    if (url.endsWith("/git/commits") && method === "POST") {
      return Response.json({ sha: NEW_SHA });
    }
    if (url.includes("/git/refs/heads/") && method === "PATCH") {
      patchCount++;
      if (opts.patchRef) return opts.patchRef(patchCount);
      return Response.json({ object: { sha: body.sha } });
    }
    return new Response("not found", { status: 404 });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function makeStore(mock: ReturnType<typeof githubMock>) {
  return new GitHubInstanceStore({
    repo: "owner/brain",
    ref: "main",
    token: "test-token-not-real",
    fetchImpl: mock.fetchImpl,
  });
}

// ---- tar reader -------------------------------------------------------------

describe("tar reader", () => {
  it("round-trips a fixture tarball, stripping the top-level dir", async () => {
    const gz = buildTarball({ "a.md": "alpha", "dir/b.md": "beta" });
    const files = parseTar(await gunzip(gz));
    expect(files.get("a.md")).toBe("alpha");
    expect(files.get("dir/b.md")).toBe("beta");
    expect(files.size).toBe(2);
  });

  it("gunzip passes through non-gzip bytes", async () => {
    const raw = new TextEncoder().encode("plain");
    expect(await gunzip(raw)).toEqual(raw);
  });
});

// ---- github-auth ------------------------------------------------------------

describe("githubToken", () => {
  it("returns the env token and never invents one", async () => {
    await expect(githubToken({ GITHUB_TOKEN: "tok" })).resolves.toBe("tok");
    await expect(githubToken({ GITHUB_TOKEN: "" })).rejects.toThrow(/GITHUB_TOKEN/);
  });
});

// ---- store reads ------------------------------------------------------------

describe("GitHubInstanceStore reads", () => {
  it("loads config with defaults merged", async () => {
    const store = makeStore(githubMock());
    const config = await store.loadConfig();
    expect(config.bundle).toBe("bundle");
    expect(config.ledger).toBe("ledger/actions.jsonl");
    expect(config.reports).toBe("reports");
  });

  it("loads the bundle from the tarball with relPaths", async () => {
    const store = makeStore(githubMock());
    const bundle = await store.loadBundle();
    const rels = bundle.concepts.map((c) => c.relPath).sort();
    expect(rels).toEqual(["agents/scout.md", "constitution.md", "index.md", "log.md", "ops/calendar.md"]);
    const scout = bundle.concepts.find((c) => c.relPath === "agents/scout.md")!;
    expect(scout.frontmatter.name).toBe("scout");
    expect(scout.path).toBe(scout.relPath); // no disk paths in the remote store
  });

  it("readOptional returns content or null", async () => {
    const store = makeStore(githubMock());
    expect(await store.readOptional("bundle/index.md")).toContain("# Index");
    expect(await store.readOptional("bundle/nope.md")).toBeNull();
  });

  it("lists and reads reports and approvals from the snapshot", async () => {
    const store = makeStore(githubMock());
    expect(await store.listReports()).toEqual(["2026-01-01-scout-old00000.md"]);
    expect(await store.readReport("2026-01-01-scout-old00000.md")).toContain("old report");
    expect((await store.listApprovals("pending")).map((a) => a.id)).toEqual(["appr-1"]);
    expect((await store.getApproval("appr-1"))?.summary).toBe("test approval");
    expect(await store.getApproval("nope")).toBeUndefined();
  });

  it("sends a User-Agent on every request", async () => {
    const mock = githubMock();
    const store = makeStore(mock);
    await store.loadBundle();
    expect(mock.calls.length).toBeGreaterThan(0);
    for (const call of mock.calls) {
      expect(call.headers["User-Agent"]).toBe("animamesh");
    }
  });
});

// ---- read-your-writes + flush ----------------------------------------------

describe("GitHubInstanceStore writes", () => {
  it("read-your-writes: ledger appends and report writes visible before flush", async () => {
    const store = makeStore(githubMock());
    await store.appendLedger({ ts: "t", runId: "r1", agent: "scout", action: "run-started", type: "report" });
    const entries = await store.readLedger();
    expect(entries.map((e) => e.runId)).toEqual(["old", "r1"]);

    await store.writeReport("2026-07-11-scout-r1.md", "fresh");
    expect(await store.listReports()).toContain("2026-07-11-scout-r1.md");
    expect(await store.readReport("2026-07-11-scout-r1.md")).toBe("fresh");
  });

  it("flush is a no-op with nothing dirty", async () => {
    const mock = githubMock();
    const store = makeStore(mock);
    expect(await store.flush("empty")).toEqual({});
    expect(mock.calls).toHaveLength(0);
  });

  it("flush produces one commit: tree with composed contents, force:false ref update", async () => {
    const mock = githubMock();
    const store = makeStore(mock);
    await store.appendLedger({ ts: "t", runId: "r1", agent: "scout", action: "run-started", type: "report" });
    await store.writeReport("new.md", "body");

    const { commitSha } = await store.flush("beat(scout): run r1");
    expect(commitSha).toBe(NEW_SHA);

    const tree = mock.calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"))!;
    const paths = tree.body.tree.map((t: any) => t.path).sort();
    expect(paths).toEqual(["ledger/actions.jsonl", "reports/new.md"]);
    const ledgerBlob = tree.body.tree.find((t: any) => t.path === "ledger/actions.jsonl");
    expect(ledgerBlob.content).toContain('"runId":"old"'); // append composed onto base
    expect(ledgerBlob.content.trim().split("\n")).toHaveLength(2);
    expect(ledgerBlob.mode).toBe("100644");

    const commit = mock.calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"))!;
    expect(commit.body.message).toBe("beat(scout): run r1");
    expect(commit.body.parents).toEqual([BASE_SHA]);
    expect(commit.body.author.name).toBe("animamesh-cloud");

    const patch = mock.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body.force).toBe(false);
    expect(patch.body.sha).toBe(NEW_SHA);
  });

  it("retries ONCE when the ref moves under us, then succeeds", async () => {
    const mock = githubMock({
      patchRef: (n) => (n === 1 ? new Response("conflict", { status: 422 }) : Response.json({})),
    });
    const store = makeStore(mock);
    await store.writeReport("new.md", "body");
    const { commitSha } = await store.flush("retry test");
    expect(commitSha).toBe(NEW_SHA);
    expect(mock.calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
  });

  it("fails loudly (no force) when the retry also loses", async () => {
    const mock = githubMock({ patchRef: () => new Response("conflict", { status: 422 }) });
    const store = makeStore(mock);
    await store.writeReport("new.md", "body");
    await expect(store.flush("always conflict")).rejects.toThrow(/422/);
    expect(mock.calls.filter((c) => c.method === "PATCH")).toHaveLength(2); // exactly one retry
  });

  it("never leaks the token in error messages", async () => {
    const mock = githubMock({ patchRef: () => new Response("conflict", { status: 422 }) });
    const store = makeStore(mock);
    await store.writeReport("new.md", "body");
    await expect(store.flush("x")).rejects.toSatisfy((e: Error) => !e.message.includes("test-token-not-real"));
  });
});

// ---- the seam proof: a full run through the remote store --------------------

describe("runAgent over GitHubInstanceStore", () => {
  it("runs an agent with zero local reads and lands report + 3 ledger lines in ONE commit", async () => {
    const mock = githubMock();
    const store = makeStore(mock);
    const provider = new FakeProvider(() => ({ text: "remote report body" }));

    const report = await runAgent({
      store,
      agentName: "scout",
      provider,
      now: new Date("2026-07-11T12:00:00"),
      runId: "12345678-0000-0000-0000-000000000000",
    });

    expect(report.ok).toBe(true);
    expect(report.reportPath).toBe("reports/2026-07-11-scout-12345678.md");
    for (const v of report.verifierResults) expect(v.ok).toBe(true);

    // Exactly one commit (flushPolicy per-run default) containing both artifacts.
    const trees = mock.calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/trees"));
    expect(trees).toHaveLength(1);
    const paths = trees[0]!.body.tree.map((t: any) => t.path).sort();
    expect(paths).toEqual(["ledger/actions.jsonl", "reports/2026-07-11-scout-12345678.md"]);
    const ledgerBlob = trees[0]!.body.tree.find((t: any) => t.path === "ledger/actions.jsonl");
    const lines = ledgerBlob.content.trim().split("\n");
    expect(lines).toHaveLength(4); // 1 old + started/written/completed
    expect(mock.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);

    // The prompt was assembled from the tarball, not the disk.
    expect(provider.calls[0]!.prompt).toContain("annual return");
  });
});
