import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import { makeTree, concept } from "./helpers.js";
import {
  parseDefectReports,
  stripDefectReports,
  identityLeakGuard,
  engineRepoSlug,
  createDefectIssue,
  MAX_DEFECTS_PER_RUN,
} from "../src/defects/report-core.js";
import { runAgent } from "../src/harness/run.js";
import { FakeProvider } from "../src/providers/fake.js";
import { Ledger } from "../src/ledger/ledger.js";
import type { InstanceConfig } from "../src/instance/config-core.js";
import { DEFAULT_CONFIG } from "../src/instance/config-core.js";

/**
 * Defect reports — the mesh's feedback loop into the engine. These prove the
 * contract from defects/report-core.ts + harness/defects.ts: model proposes,
 * code disposes; the identity-leak guard keeps instance identity off the
 * public engine repo (D2/D13); a promised filing lands or its denial is
 * ledgered; no credential is an honest denial, never a crash.
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

describe("defect-report through a beat run — model proposes, code disposes", () => {
  function agentFile(extra: Record<string, unknown> = {}): string {
    return concept(
      "agent",
      { name: "hub", title: "Hub", level: "L3", model: "test-model", harness: "fake", heartbeat: "daily", ...extra },
      "Do the job.",
    );
  }

  async function makeInstance(agentExtra: Record<string, unknown> = {}): Promise<string> {
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

  const CLEAN_REPORT = [
    "## Brief",
    "",
    defectBlock("Harness drops trailing newline in reports", "Repro: run any beat; expected trailing newline, got none."),
    "",
  ].join("\n");

  it("whitelisted L3 agent files the issue; ledger records the URL; verifiers stay green", async () => {
    const root = await makeInstance({ whitelist: ["defect-report"] });
    const { fetchImpl, posts } = githubStub();
    const report = await runAgent({
      instanceRoot: root,
      agentName: "hub",
      provider: new FakeProvider(() => ({ text: CLEAN_REPORT })),
      runId: "run-defect",
      providerCtx: { env: { GITHUB_DEFECTS_TOKEN: "tok" }, fetchImpl },
    });
    expect(report.ok).toBe(true);
    expect(posts).toHaveLength(1);
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-defect");
    const filed = entries.find((e) => e.action === "defect-reported");
    expect(filed?.detail).toMatchObject({ url: "https://github.com/example/engine/issues/9", duplicate: false });
  });

  it("denies without the whitelist: ledgered, nothing posted, run unaffected", async () => {
    const root = await makeInstance(); // L3 but no whitelist entry
    const { fetchImpl, posts } = githubStub();
    const report = await runAgent({
      instanceRoot: root,
      agentName: "hub",
      provider: new FakeProvider(() => ({ text: CLEAN_REPORT })),
      runId: "run-deny",
      providerCtx: { env: { GITHUB_DEFECTS_TOKEN: "tok" }, fetchImpl },
    });
    expect(report.ok).toBe(true);
    expect(posts).toHaveLength(0);
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-deny");
    const denied = entries.find((e) => e.action === "defect-report-denied");
    expect(String((denied?.detail as { reason?: string }).reason)).toContain("whitelist");
  });

  it("denies an identity leak: the public repo never sees instance names", async () => {
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
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-leak");
    const denied = entries.find((e) => e.action === "defect-report-denied");
    expect(String((denied?.detail as { reason?: string }).reason)).toContain("identity leak");
  });

  it("no credential is an honest ledgered denial naming the fix", async () => {
    const root = await makeInstance({ whitelist: ["defect-report"] });
    const failFetch = (async () => new Response("unreachable", { status: 500 })) as typeof fetch;
    await runAgent({
      instanceRoot: root,
      agentName: "hub",
      provider: new FakeProvider(() => ({ text: CLEAN_REPORT })),
      runId: "run-nocred",
      // Partial App config makes githubToken throw deterministically, no
      // matter what GITHUB_* the host process carries.
      providerCtx: { env: { GITHUB_APP_ID: "1" }, fetchImpl: failFetch },
    });
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-nocred");
    const denied = entries.find((e) => e.action === "defect-report-denied");
    expect(String((denied?.detail as { reason?: string }).reason)).toContain("GITHUB_DEFECTS_TOKEN");
  });

  it(`caps at ${MAX_DEFECTS_PER_RUN} filings per run and ledgers the overflow`, async () => {
    const many = [
      "## Brief",
      "",
      defectBlock("Bug one", "Repro one."),
      defectBlock("Bug two", "Repro two."),
      defectBlock("Bug three", "Repro three."),
      "",
    ].join("\n");
    const root = await makeInstance({ whitelist: ["defect-report"] });
    const { fetchImpl, posts } = githubStub();
    await runAgent({
      instanceRoot: root,
      agentName: "hub",
      provider: new FakeProvider(() => ({ text: many })),
      runId: "run-cap",
      providerCtx: { env: { GITHUB_DEFECTS_TOKEN: "tok" }, fetchImpl },
    });
    expect(posts).toHaveLength(MAX_DEFECTS_PER_RUN);
    const entries = new Ledger(path.join(root, "ledger/actions.jsonl")).entriesForRun("run-cap");
    const overflow = entries.find(
      (e) => e.action === "defect-report-denied" && String((e.detail as { reason?: string }).reason).includes("cap"),
    );
    expect(overflow).toBeDefined();
  });
});
