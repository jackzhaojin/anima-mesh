import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { makeTree, concept } from "./helpers.js";
import {
  parseDefectReports,
  stripDefectReports,
  identityLeakGuard,
  engineRepoSlug,
  createDefectIssue,
  defectDraftSlug,
  MAX_DEFECTS_PER_RUN,
} from "../src/defects/report-core.js";
import { listDefectDrafts, fileDefectDrafts } from "../src/defects/file.js";
import { runAgent } from "../src/harness/run.js";
import { FakeProvider } from "../src/providers/fake.js";
import { Ledger } from "../src/ledger/ledger.js";
import type { InstanceConfig } from "../src/instance/config-core.js";
import { DEFAULT_CONFIG } from "../src/instance/config-core.js";

/**
 * Defect reports — the mesh's feedback loop into the engine, DRAFTS-FIRST.
 * These prove the contract from defects/report-core.ts + harness/defects.ts
 * + defects/file.ts: a defect-report block becomes a draft in the instance's
 * own repo with NO credential (the store write covers it); filing to the
 * public engine repo is a deliberate later step (or an explicit-token
 * opt-in), and the identity-leak guard runs at that public boundary
 * (D2/D13). Model proposes, code disposes.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function defectBlock(title: string, body: string): string {
  return ["```defect-report", `title: ${title}`, "---", body, "```"].join("\n");
}

const config: InstanceConfig = {
  ...DEFAULT_CONFIG,
  engine: { repo: "github.com/example/engine" },
  identity: {
    principal: { name: "Ada Lovelace", email: "ada@example.com" },
    persona: { name: "Quill Byron", emails: ["quill@example.com"] },
  },
};

describe("parseDefectReports / stripDefectReports", () => {
  it("extracts title and body; malformed or empty blocks are skipped", () => {
    const text = [
      "Report prose.",
      defectBlock("Beat crashes on empty schedule frontmatter", "Repro: run heartbeat with `wake: null`."),
      "```defect-report\nno title line\n```",
      defectBlock("Empty body", "   \n"),
    ].join("\n\n");
    const reports = parseDefectReports(text);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.title).toBe("Beat crashes on empty schedule frontmatter");
    expect(reports[0]!.body).toContain("wake: null");
  });

  it("strip removes blocks, keeps prose", () => {
    const text = `Before.\n\n${defectBlock("t", "b")}\n\nAfter.`;
    const stripped = stripDefectReports(text);
    expect(stripped).toContain("Before.");
    expect(stripped).toContain("After.");
    expect(stripped).not.toContain("defect-report");
  });
});

describe("engineRepoSlug", () => {
  it("normalizes URL-ish forms to owner/name and rejects garbage", () => {
    expect(engineRepoSlug(config)).toBe("example/engine");
    expect(engineRepoSlug({ ...config, engine: { repo: "https://github.com/o/r.git" } })).toBe("o/r");
    expect(engineRepoSlug({ ...config, engine: { repo: "o/r" } })).toBe("o/r");
    expect(engineRepoSlug({ ...config, engine: {} })).toBeNull();
    expect(engineRepoSlug({ ...config, engine: { repo: "not a repo at all" } })).toBeNull();
  });
});

describe("identityLeakGuard — D2/D13 on the public surface", () => {
  it("flags principal/persona name words and configured emails, case-insensitively", () => {
    expect(identityLeakGuard("The harness dropped Ada's approval", config)).toContain("Ada");
    expect(identityLeakGuard("persona QUILL failed to deliver", config)).toContain("Quill");
    expect(identityLeakGuard("mail loop with ada@example.com", config)).toContain("ada@example.com");
  });

  it("passes generic engine language and avoids substring false positives", () => {
    expect(identityLeakGuard("Worker 403s when the UA header is missing", config)).toEqual([]);
    // "Quillby" ≠ the word "Quill"; word boundaries protect ordinary prose.
    expect(identityLeakGuard("the quillby module regressed", config)).toEqual([]);
  });
});

describe("createDefectIssue — dedup then create", () => {
  function fakeGithub(existing: { title: string; html_url: string; number: number }[]) {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify(existing), { status: 200 });
      }
      return new Response(JSON.stringify({ html_url: "https://github.com/example/engine/issues/42", number: 42 }), {
        status: 201,
      });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it("files a labeled issue with a User-Agent and returns its URL", async () => {
    const { fetchImpl, calls } = fakeGithub([]);
    const result = await createDefectIssue({
      repo: "example/engine",
      title: "Beat crashes on empty schedule",
      body: "Repro…",
      token: "tok",
      fetchImpl,
    });
    expect(result).toEqual({ url: "https://github.com/example/engine/issues/42", number: 42, duplicate: false });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://api.github.com/repos/example/engine/issues");
    expect(post.body).toMatchObject({ title: "Beat crashes on empty schedule", labels: ["defect"] });
  });

  it("returns the existing open issue instead of filing a duplicate", async () => {
    const { fetchImpl, calls } = fakeGithub([
      { title: "beat crashes on empty schedule", html_url: "https://github.com/example/engine/issues/7", number: 7 },
    ]);
    const result = await createDefectIssue({
      repo: "example/engine",
      title: "Beat crashes on Empty Schedule",
      body: "Repro…",
      token: "tok",
      fetchImpl,
    });
    expect(result.duplicate).toBe(true);
    expect(result.number).toBe(7);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("throws with status detail when GitHub rejects the create", async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response("Resource not accessible", { status: 403 })
        : new Response("[]", { status: 200 })) as typeof fetch;
    await expect(
      createDefectIssue({ repo: "example/engine", title: "t", body: "b", token: "tok", fetchImpl }),
    ).rejects.toThrow(/403/);
  });
});

function agentFile(extra: Record<string, unknown> = {}): string {
  return concept(
    "agent",
    { name: "hub", title: "Hub", level: "L3", model: "test-model", harness: "fake", heartbeat: "daily", ...extra },
    "Do the job.",
  );
}

async function makeInstance(agentExtra: Record<string, unknown> = {}, extraFiles: Record<string, string> = {}): Promise<string> {
  const root = await makeTree({
    "animamesh.config.json": JSON.stringify({
      bundle: "bundle",
      engine: { repo: "github.com/example/engine" },
      identity: { principal: { name: "Ada Lovelace" }, persona: { name: "Quill Byron" } },
    }),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/agents/hub.md": agentFile(agentExtra),
    ...extraFiles,
  });
  roots.push(root);
  return root;
}

function githubStub() {
  const posts: unknown[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ html_url: "https://github.com/example/engine/issues/9", number: 9 }), {
        status: 201,
      });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, posts };
}

const CLEAN_TITLE = "Harness drops trailing newline in reports";
const CLEAN_SLUG = defectDraftSlug(CLEAN_TITLE);
const CLEAN_REPORT = [
  "## Brief",
  "",
  defectBlock(CLEAN_TITLE, "Repro: run any beat; expected trailing newline, got none."),
  "",
].join("\n");

describe("defect-report through a beat run — drafts-first, no credential needed", () => {
  it("whitelisted L3 agent gets a draft in drafts/defects/, ledgered, verifiers green — zero network", async () => {
    const root = await makeInstance({ whitelist: ["defect-report"] });
    const { fetchImpl, posts } = githubStub();
    const report = await runAgent({
      instanceRoot: root,
      agentName: "hub",
      provider: new FakeProvider(() => ({ text: CLEAN_REPORT })),
      runId: "run-draft",
      providerCtx: { env: {}, fetchImpl }, // no token anywhere → draft only
    });
    expect(report.ok).toBe(true);
    expect(posts).toHaveLength(0);
    const draft = await readFile(path.join(root, `drafts/defects/${CLEAN_SLUG}.md`), "utf8");
    expect(draft).toContain(`title: ${JSON.stringify(CLEAN_TITLE)}`);
    expect(draft).toContain("filed: no");
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-draft");
    const drafted = entries.find((e) => e.action === "defect-drafted");
    expect(drafted?.detail).toMatchObject({ path: `drafts/defects/${CLEAN_SLUG}.md` });
  });

  it("recurrence overwrites the same draft — one file per distinct defect", async () => {
    const root = await makeInstance({ whitelist: ["defect-report"] });
    const fake = new FakeProvider(() => ({ text: CLEAN_REPORT }));
    await runAgent({ instanceRoot: root, agentName: "hub", provider: fake, runId: "run-a", providerCtx: { env: {} } });
    await runAgent({ instanceRoot: root, agentName: "hub", provider: fake, runId: "run-b", providerCtx: { env: {} } });
    const drafts = listDefectDrafts(root);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.runId).toBe("run-b");
  });

  it("with GITHUB_DEFECTS_TOKEN explicitly set, the run also files and annotates the draft", async () => {
    const root = await makeInstance({ whitelist: ["defect-report"] });
    const { fetchImpl, posts } = githubStub();
    await runAgent({
      instanceRoot: root,
      agentName: "hub",
      provider: new FakeProvider(() => ({ text: CLEAN_REPORT })),
      runId: "run-autofile",
      providerCtx: { env: { GITHUB_DEFECTS_TOKEN: "tok" }, fetchImpl },
    });
    expect(posts).toHaveLength(1);
    const draft = await readFile(path.join(root, `drafts/defects/${CLEAN_SLUG}.md`), "utf8");
    expect(draft).toContain("filed: https://github.com/example/engine/issues/9");
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-autofile");
    expect(entries.some((e) => e.action === "defect-filed")).toBe(true);
  });

  it("a leaky report still drafts (private repo) but auto-filing is skipped with the reason ledgered", async () => {
    const leaky = ["## Brief", "", defectBlock("Discord delivery to Quill fails", "Ada saw a blank DM."), ""].join("\n");
    const root = await makeInstance({ whitelist: ["defect-report"] });
    const { fetchImpl, posts } = githubStub();
    await runAgent({
      instanceRoot: root,
      agentName: "hub",
      provider: new FakeProvider(() => ({ text: leaky })),
      runId: "run-leak",
      providerCtx: { env: { GITHUB_DEFECTS_TOKEN: "tok" }, fetchImpl },
    });
    expect(posts).toHaveLength(0);
    const draft = await readFile(path.join(root, `drafts/defects/${defectDraftSlug("Discord delivery to Quill fails")}.md`), "utf8");
    expect(draft).toContain("leak-check");
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-leak");
    const skipped = entries.find((e) => e.action === "defect-file-skipped");
    expect(String((skipped?.detail as { reason?: string }).reason)).toContain("identity leak");
  });

  it("denies without the whitelist: ledgered, no draft, run unaffected", async () => {
    const root = await makeInstance(); // L3 but no whitelist entry
    const report = await runAgent({
      instanceRoot: root,
      agentName: "hub",
      provider: new FakeProvider(() => ({ text: CLEAN_REPORT })),
      runId: "run-deny",
      providerCtx: { env: {} },
    });
    expect(report.ok).toBe(true);
    expect(existsSync(path.join(root, "drafts/defects"))).toBe(false);
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-deny");
    const denied = entries.find((e) => e.action === "defect-report-denied");
    expect(String((denied?.detail as { reason?: string }).reason)).toContain("whitelist");
  });

  it(`caps at ${MAX_DEFECTS_PER_RUN} drafts per run and ledgers the overflow`, async () => {
    const many = [
      "## Brief",
      "",
      defectBlock("Bug one", "Repro one."),
      defectBlock("Bug two", "Repro two."),
      defectBlock("Bug three", "Repro three."),
      "",
    ].join("\n");
    const root = await makeInstance({ whitelist: ["defect-report"] });
    await runAgent({
      instanceRoot: root,
      agentName: "hub",
      provider: new FakeProvider(() => ({ text: many })),
      runId: "run-cap",
      providerCtx: { env: {} },
    });
    expect(listDefectDrafts(root)).toHaveLength(MAX_DEFECTS_PER_RUN);
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-cap");
    const overflow = entries.find(
      (e) => e.action === "defect-report-denied" && String((e.detail as { reason?: string }).reason).includes("cap"),
    );
    expect(overflow).toBeDefined();
  });
});

describe("defect file — the deliberate promotion step", () => {
  function draftFile(title: string, body: string, extra: Record<string, unknown> = {}): string {
    return concept("defect-draft", { title, agent: "hub", runId: "run-x", filed: "no", ...extra }, body);
  }

  it("files unfiled drafts, writes the URL back, and skips already-filed ones", async () => {
    const root = await makeInstance({}, {
      "drafts/defects/bug-one.md": draftFile("Bug one", "Generic repro."),
      "drafts/defects/bug-two.md": draftFile("Bug two", "Generic repro.", { filed: "https://github.com/example/engine/issues/1" }),
    });
    const { fetchImpl, posts } = githubStub();
    const result = await fileDefectDrafts({ instanceRoot: root, all: true, token: "tok", fetchImpl });
    expect(result.filed.map((f) => f.slug)).toEqual(["bug-one"]);
    expect(result.skipped[0]).toMatchObject({ slug: "bug-two" });
    expect(posts).toHaveLength(1);
    const draft = await readFile(path.join(root, "drafts/defects/bug-one.md"), "utf8");
    expect(draft).toContain("filed: https://github.com/example/engine/issues/9");
  });

  it("never files a leaking draft — re-checked against the CURRENT file content", async () => {
    const root = await makeInstance({}, {
      "drafts/defects/leaky.md": draftFile("Report about Quill", "Ada hit this."),
    });
    const { fetchImpl, posts } = githubStub();
    const result = await fileDefectDrafts({ instanceRoot: root, all: true, token: "tok", fetchImpl });
    expect(posts).toHaveLength(0);
    expect(result.skipped[0]!.reason).toContain("identity leak");
  });

  it("naming an unknown slug fails loudly; list surfaces status", async () => {
    const root = await makeInstance({}, {
      "drafts/defects/bug-one.md": draftFile("Bug one", "Generic repro."),
    });
    await expect(fileDefectDrafts({ instanceRoot: root, slugs: ["nope"], token: "t" })).rejects.toThrow(/no defect draft/);
    const drafts = listDefectDrafts(root);
    expect(drafts[0]).toMatchObject({ slug: "bug-one", filedUrl: undefined });
  });
});
