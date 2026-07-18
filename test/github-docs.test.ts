import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  githubDocsConfigured,
  listDocs,
  readDocsFile,
  docsListingMarkdown,
} from "../src/sources/github-docs.js";
import { nodeSourceFs } from "../src/sources/local-files.js";
import { sourceSections } from "../src/sources/registry.js";

/**
 * The 'github-docs' read source: one corpus, two access paths. The API path
 * against a scripted GitHub REST (recursive trees + raw contents, token
 * precedence, tokenless public reads); the local path against a real temp
 * working tree via the injected Node capability (excludes honored, root
 * escapes refused); and the honest-section failure posture.
 */

// Empty strings (not absent keys) so getEnv's process.env fallback can never
// leak a developer's real GITHUB_TOKEN into these tests.
const NO_TOKENS = { GITHUB_DOCS_TOKEN: "", GITHUB_TOKEN: "" };
const ENV = { ...NO_TOKENS, GITHUB_DOCS_REPO: "acme/docs", GITHUB_DOCS_TOKEN: "pat-docs" };

const TREE = {
  tree: [
    { path: "plans", type: "tree" },
    { path: "readme.md", type: "blob", size: 100 },
    { path: "plans/roadmap.md", type: "blob", size: 2048 },
    { path: "plans/logo.png", type: "blob", size: 4096 },
    { path: "archive/old.txt", type: "blob", size: 10 },
  ],
  truncated: false,
};

function githubFetch(overrides: Record<string, (url: string, init?: RequestInit) => Response> = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    for (const [needle, handler] of Object.entries(overrides)) {
      if (url.includes(needle)) return handler(url, init);
    }
    if (url.includes("/git/trees/")) return Response.json(TREE);
    if (url.includes("/contents/readme.md")) return new Response("# Readme\nhello");
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("listDocs (API path)", () => {
  it("lists blobs only, sorted, with sizes — folders and out-of-subpath entries dropped", async () => {
    const mock = githubFetch();
    const listing = await listDocs({ env: ENV, fetchImpl: mock.fetchImpl });
    expect(listing.entries.map((e) => e.path)).toEqual([
      "archive/old.txt",
      "plans/logo.png",
      "plans/roadmap.md",
      "readme.md",
    ]);
    expect(listing.entries.find((e) => e.path === "plans/roadmap.md")!.size).toBe(2048);
    expect(listing.origin).toBe("acme/docs@HEAD");
    expect(listing.truncated).toBe(false);
    // Read-only by construction: every call was a GET.
    for (const c of mock.calls) expect(c.method).toBe("GET");
  });

  it("scopes to GITHUB_DOCS_PATH and honors GITHUB_DOCS_REF", async () => {
    const mock = githubFetch();
    const listing = await listDocs({
      env: { ...ENV, GITHUB_DOCS_PATH: "plans", GITHUB_DOCS_REF: "v2" },
      fetchImpl: mock.fetchImpl,
    });
    expect(listing.entries.map((e) => e.path)).toEqual(["plans/logo.png", "plans/roadmap.md"]);
    expect(mock.calls[0]!.url).toContain("/repos/acme/docs/git/trees/v2?recursive=1");
    expect(listing.origin).toBe("acme/docs@v2");
  });

  it("sends GITHUB_DOCS_TOKEN as Bearer, falls back to GITHUB_TOKEN, goes tokenless when neither", async () => {
    const withDocs = githubFetch();
    await listDocs({ env: ENV, fetchImpl: withDocs.fetchImpl });
    expect(withDocs.calls[0]!.headers.Authorization).toBe("Bearer pat-docs");

    const withFallback = githubFetch();
    await listDocs({
      env: { GITHUB_DOCS_REPO: "acme/docs", GITHUB_DOCS_TOKEN: "", GITHUB_TOKEN: "pat-main" },
      fetchImpl: withFallback.fetchImpl,
    });
    expect(withFallback.calls[0]!.headers.Authorization).toBe("Bearer pat-main");

    const tokenless = githubFetch();
    await listDocs({ env: { ...NO_TOKENS, GITHUB_DOCS_REPO: "acme/docs" }, fetchImpl: tokenless.fetchImpl });
    expect(tokenless.calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("bounds the listing at maxEntries and surfaces the trees API's own truncation", async () => {
    const mock = githubFetch();
    const clipped = await listDocs({ env: ENV, fetchImpl: mock.fetchImpl }, { maxEntries: 2 });
    expect(clipped.entries).toHaveLength(2);
    expect(clipped.truncated).toBe(true);

    const upstream = githubFetch({
      "/git/trees/": () => Response.json({ ...TREE, truncated: true }),
    });
    const listing = await listDocs({ env: ENV, fetchImpl: upstream.fetchImpl });
    expect(listing.truncated).toBe(true);
  });

  it("hints at the missing token on a 404 — the private-repo failure shape", async () => {
    const mock = githubFetch({ "/git/trees/": () => new Response("Not Found", { status: 404 }) });
    await expect(
      listDocs({ env: { ...NO_TOKENS, GITHUB_DOCS_REPO: "acme/docs" }, fetchImpl: mock.fetchImpl }),
    ).rejects.toThrow(/HTTP 404 \(private repo with no token\?\)/);
  });

  it("rejects a malformed GITHUB_DOCS_REPO instead of building a bad URL", async () => {
    await expect(listDocs({ env: { ...NO_TOKENS, GITHUB_DOCS_REPO: "not-a-repo" } })).rejects.toThrow(
      /owner\/name/,
    );
  });
});

describe("listDocs (local working tree via injected sourceFs)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "github-docs-test-"));
    mkdirSync(path.join(root, "plans"));
    mkdirSync(path.join(root, ".git"));
    mkdirSync(path.join(root, "local-secrets"));
    writeFileSync(path.join(root, "readme.md"), "# hi\n");
    writeFileSync(path.join(root, "plans", "roadmap.md"), "roadmap body\n");
    writeFileSync(path.join(root, ".git", "config"), "[core]\n");
    writeFileSync(path.join(root, "local-secrets", "token.txt"), "SECRET\n");
    writeFileSync(path.join(root, "scratch.log"), "noise\n");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function localEnv(extra: Record<string, string> = {}) {
    return { ...NO_TOKENS, GITHUB_DOCS_LOCAL_PATH: root, GITHUB_DOCS_EXCLUDE: "local-secrets,scratch.log", ...extra };
  }

  it("lists the tree from disk — excludes and .git honored, metadata recorded, no fetch at all", async () => {
    const mock = githubFetch();
    const listing = await listDocs({ env: localEnv(), fetchImpl: mock.fetchImpl, sourceFs: nodeSourceFs });
    expect(listing.entries.map((e) => e.path)).toEqual(["plans/roadmap.md", "readme.md"]);
    const readme = listing.entries.find((e) => e.path === "readme.md")!;
    expect(readme.size).toBeGreaterThan(0);
    expect(readme.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(listing.origin).toBe(`local working tree ${root}`);
    expect(mock.calls).toHaveLength(0);
  });

  it("applies GITHUB_DOCS_PATH in local mode too — one corpus, same scoping", async () => {
    const listing = await listDocs({ env: localEnv({ GITHUB_DOCS_PATH: "plans" }), sourceFs: nodeSourceFs });
    expect(listing.entries.map((e) => e.path)).toEqual(["plans/roadmap.md"]);
  });

  it("falls back to the API when the capability is absent (the Workers shape)", async () => {
    const mock = githubFetch();
    const listing = await listDocs({
      env: { ...localEnv(), GITHUB_DOCS_REPO: "acme/docs" },
      fetchImpl: mock.fetchImpl,
    });
    expect(listing.origin).toBe("acme/docs@HEAD");
    expect(mock.calls.length).toBeGreaterThan(0);
  });

  it("readDocsFile reads from disk and refuses paths that escape the root", async () => {
    const text = await readDocsFile({ env: localEnv(), sourceFs: nodeSourceFs }, "plans/roadmap.md");
    expect(text).toBe("roadmap body\n");
    await expect(
      readDocsFile({ env: localEnv(), sourceFs: nodeSourceFs }, "../outside.md"),
    ).rejects.toThrow(/escapes the source root/);
  });
});

describe("readDocsFile (API path)", () => {
  it("fetches raw contents at the ref and clips long bodies", async () => {
    const mock = githubFetch();
    const text = await readDocsFile({ env: ENV, fetchImpl: mock.fetchImpl }, "readme.md");
    expect(text).toBe("# Readme\nhello");
    const call = mock.calls.find((c) => c.url.includes("/contents/readme.md"))!;
    expect(call.url).toContain("ref=HEAD");
    expect(call.headers.Accept).toBe("application/vnd.github.raw+json");

    const clipped = await readDocsFile({ env: ENV, fetchImpl: mock.fetchImpl }, "readme.md", { maxChars: 4 });
    expect(clipped).toBe("# Re\n…(truncated)");
  });

  it("refuses binary formats by extension — sources inline text only", async () => {
    await expect(readDocsFile({ env: ENV }, "plans/logo.png")).rejects.toThrow(/not a text format/);
  });
});

describe("docsListingMarkdown", () => {
  it("renders one line per file with meta, plus an honest count/origin note", () => {
    const md = docsListingMarkdown({
      entries: [
        { path: "readme.md", size: 100 },
        { path: "plans/roadmap.md", size: 2048, lastModified: "2026-07-15T12:00:00Z" },
      ],
      truncated: false,
      origin: "acme/docs@HEAD",
    });
    expect(md).toContain("- readme.md (100 B)");
    expect(md).toContain("- plans/roadmap.md (2 KB, 2026-07-15)");
    expect(md).toContain("2 files from acme/docs@HEAD");
    expect(md).not.toContain("listing bounded");
  });

  it("marks bounded listings — truncation is never silent", () => {
    const md = docsListingMarkdown({ entries: [{ path: "a.md" }], truncated: true, origin: "acme/docs@HEAD" });
    expect(md).toContain("listing bounded");
  });
});

describe("sourceSections('github-docs')", () => {
  it("inlines the live listing with its origin", async () => {
    const mock = githubFetch();
    const sections = await sourceSections(["github-docs"], { env: ENV, fetchImpl: mock.fetchImpl });
    expect(sections[0]).toContain("## Docs repo");
    expect(sections[0]).toContain("acme/docs@HEAD");
    expect(sections[0]).toContain("plans/roadmap.md");
  });

  it("says so honestly when declared but unconfigured — and does not throw", async () => {
    expect(githubDocsConfigured({ env: { GITHUB_DOCS_REPO: "", GITHUB_DOCS_LOCAL_PATH: "" } })).toBe(false);
    const sections = await sourceSections(["github-docs"], {
      env: { GITHUB_DOCS_REPO: "", GITHUB_DOCS_LOCAL_PATH: "" },
    });
    expect(sections[0]).toContain("not configured");
    expect(sections[0]).toContain("GITHUB_DOCS_REPO");
  });

  it("turns an API outage into an honest section, never an aborted run", async () => {
    const mock = githubFetch({ "/git/trees/": () => new Response("boom", { status: 500 }) });
    const sections = await sourceSections(["github-docs"], { env: ENV, fetchImpl: mock.fetchImpl });
    expect(sections[0]).toContain("configured but unreachable this run");
    expect(sections[0]).toContain("HTTP 500");
  });
});
