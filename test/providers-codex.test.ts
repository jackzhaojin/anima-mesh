import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { codexExecArgs, parseCodexEvents } from "../src/providers/codex.js";
import { createOpenAICodexProvider } from "../src/providers/openai-codex.js";
import { staticCodexAuth, accountIdFrom } from "../src/providers/codex-auth.js";
import { fileCodexAuth } from "../src/providers/codex-auth-file.js";
import { resolveProvider, CLOUD_HARNESSES } from "../src/providers/index.js";
import "../src/providers/node-providers.js";
import { makeTree } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

/** An unsigned JWT with the claims the code reads (exp, the account claim). */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}
const access = (expInSec: number, account = "acct-1") =>
  jwt({ exp: Math.floor(NOW / 1000) + expInSec, "https://api.openai.com/auth": { chatgpt_account_id: account } });

function sse(...events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const completed = (text: string) => [
  { type: "response.output_text.delta", delta: text },
  {
    type: "response.output_item.done",
    item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  },
  { type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 3 } } },
];
const fixedAuth = (accessToken = "at-1", accountId = "acct-1") =>
  vi.fn(async (_o?: { force?: boolean }) => ({ accessToken, accountId }));

describe("codex (local CLI harness)", () => {
  it("runs read-only, off-git, ephemeral, with the prompt on stdin — never argv", () => {
    const args = codexExecArgs({ cwd: "/brain", model: "gpt-5.5" });
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args.join(" ")).toContain("--sandbox read-only");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--ephemeral");
    expect(args.join(" ")).toContain("--cd /brain");
    expect(args.join(" ")).toContain("--model gpt-5.5");
    expect(args.at(-1)).toBe("-");
  });

  it("web search is disabled unless the agent budgets it — codex's own default is not", () => {
    expect(codexExecArgs({ cwd: "/b" })).toContain('web_search="disabled"');
    expect(codexExecArgs({ cwd: "/b", webSearchMaxUses: 4 })).toContain('web_search="live"');
    expect(codexExecArgs({ cwd: "/b" })).not.toContain("--model");
  });

  it("takes the LAST agent message as the report and surfaces tool activity", () => {
    const notes: string[] = [];
    const out = parseCodexEvents(
      [
        '{"type":"thread.started","thread_id":"t"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"looking..."}}',
        '{"type":"item.started","item":{"type":"command_execution","command":"cat ops/calendar.md","status":"in_progress"}}',
        "not json",
        '{"type":"item.completed","item":{"type":"agent_message","text":"  the report  "}}',
        '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}',
      ].join("\n"),
      (n) => notes.push(n),
    );
    expect(out).toEqual({ text: "the report", usage: { input_tokens: 5, output_tokens: 2 }, error: undefined });
    expect(notes).toEqual(["codex → cat ops/calendar.md"]);
  });

  it("a failed turn is an error, not an empty report", () => {
    const out = parseCodexEvents('{"type":"turn.failed","error":{"message":"usage limit reached"}}');
    expect(out.error).toBe("usage limit reached");
  });

  it("a transient reconnect `error` event does not fail a turn that then completes (seen live, 0.162.1)", () => {
    const notes: string[] = [];
    const out = parseCodexEvents(
      [
        '{"type":"turn.started"}',
        '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 503)"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"recovered report"}}',
        '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
      ].join("\n"),
      (n) => notes.push(n),
    );
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered report");
    expect(out.lastError).toContain("Reconnecting");
    expect(notes[0]).toContain("Reconnecting");
  });

  it("is registered for the laptop and never offered to a cloud beat", () => {
    expect(resolveProvider("codex").name).toBe("codex");
    expect(resolveProvider("codex").capabilities).toEqual({ fileReads: true, webSearch: true });
    expect(CLOUD_HARNESSES.has("codex")).toBe(false);
  });
});

describe("openai-codex (ChatGPT-plan Codex over fetch)", () => {
  it("sends the endpoint's required shape and reads the streamed reply", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sse(...completed("the report")));
    const provider = createOpenAICodexProvider({ env: {}, fetchImpl, codexAuth: fixedAuth() });

    const result = await provider.run({ prompt: "do the thing", cwd: "/ignored" });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.headers.authorization).toBe("Bearer at-1");
    expect(init.headers["chatgpt-account-id"]).toBe("acct-1");
    expect(init.headers.originator).toBe("anima-mesh");
    const body = JSON.parse(init.body);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.model).toBe("gpt-5.5");
    expect(typeof body.instructions).toBe("string");
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "do the thing" }] },
    ]);
    expect(body.tools).toEqual([]);
    expect(result).toEqual({ text: "the report", tokens: { input_tokens: 7, output_tokens: 3 } });
    expect(result.costUsd).toBeUndefined();
  });

  it("falls back to deltas when the backend omits completed message items", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse(
        { type: "response.output_text.delta", delta: "part " },
        { type: "response.output_text.delta", delta: "two" },
        { type: "response.completed", response: {} },
      ),
    );
    const provider = createOpenAICodexProvider({ env: {}, fetchImpl, codexAuth: fixedAuth() });
    expect((await provider.run({ prompt: "p", cwd: "/" })).text).toBe("part two");
  });

  it("an incomplete response returns what it has, flagged degraded — never a clean run", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse(
        { type: "response.output_text.delta", delta: "half" },
        { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
      ),
    );
    const provider = createOpenAICodexProvider({ env: {}, fetchImpl, codexAuth: fixedAuth() });
    const result = await provider.run({ prompt: "p", cwd: "/" });
    expect(result.text).toBe("half");
    expect(result.degraded).toContain("max_output_tokens");
  });

  it("a stream cut before completion retries, then fails loud", async () => {
    const cut = () => new Response("event: x\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"a\"}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetchImpl = vi.fn().mockImplementation(async () => cut());
    const provider = createOpenAICodexProvider({ env: {}, fetchImpl, codexAuth: fixedAuth(), retryDelaysMs: [0] });
    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toThrow(/stream failed after retries/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a 401 forces exactly one refresh, then retries with the new token", async () => {
    const codexAuth = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: "stale", accountId: "acct-1" })
      .mockResolvedValueOnce({ accessToken: "fresh", accountId: "acct-1" });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(sse(...completed("ok")));
    const provider = createOpenAICodexProvider({ env: {}, fetchImpl, codexAuth });
    expect((await provider.run({ prompt: "p", cwd: "/" })).text).toBe("ok");
    expect(codexAuth.mock.calls[1]![0]).toEqual({ force: true });
    expect(fetchImpl.mock.calls[1]![1].headers.authorization).toBe("Bearer fresh");
  });

  it("a second 401 fails loud instead of looping on refreshes", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("unauthorized", { status: 401 }));
    const codexAuth = fixedAuth();
    const provider = createOpenAICodexProvider({ env: {}, fetchImpl, codexAuth, retryDelaysMs: [0, 0] });
    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toThrow(/openai-codex → HTTP 401/);
    expect(codexAuth).toHaveBeenCalledTimes(2);
  });

  it("names the plan's usage limit on 429 and an edge block page on HTML", async () => {
    const limited = vi.fn().mockImplementation(async () => new Response('{"error":{"type":"usage_limit_reached"}}', { status: 429 }));
    const p1 = createOpenAICodexProvider({ env: {}, fetchImpl: limited, codexAuth: fixedAuth(), retryDelaysMs: [0] });
    await expect(p1.run({ prompt: "p", cwd: "/" })).rejects.toThrow(/ChatGPT plan usage limit/);

    const blocked = vi.fn().mockResolvedValue(new Response("<!DOCTYPE html><html>challenge", { status: 403 }));
    const p2 = createOpenAICodexProvider({ env: {}, fetchImpl: blocked, codexAuth: fixedAuth() });
    const err = (await p2.run({ prompt: "p", cwd: "/" }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("HTML block page");
    expect(err.message).not.toContain("DOCTYPE");
  });

  it("CODEX_BASE_URL overrides the endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sse(...completed("ok")));
    const provider = createOpenAICodexProvider({
      env: { CODEX_BASE_URL: "https://fake-codex.test/" },
      fetchImpl,
      codexAuth: fixedAuth(),
    });
    await provider.run({ prompt: "p", cwd: "/" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://fake-codex.test/responses");
  });

  it("declares server-side web search (probed live 2026-10-11), but sends the tool only with a budget", async () => {
    expect(createOpenAICodexProvider({ env: {} }).capabilities).toEqual({ fileReads: false, webSearch: true });
    const fetchImpl = vi.fn().mockImplementation(async () => sse(...completed("ok")));
    const provider = createOpenAICodexProvider({ env: {}, fetchImpl, codexAuth: fixedAuth() });
    await provider.run({ prompt: "p", cwd: "/" });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).tools).toEqual([]);
    await provider.run({ prompt: "p", cwd: "/", webSearchMaxUses: 3 });
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body).tools).toEqual([{ type: "web_search" }]);
  });

  it("surfaces each search the endpoint ran (the live event shape)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse(
        {
          type: "response.output_item.done",
          item: { type: "web_search_call", action: { type: "search", query: "top headline today" } },
        },
        ...completed("cited answer"),
      ),
    );
    const notes: string[] = [];
    const provider = createOpenAICodexProvider({ env: {}, fetchImpl, codexAuth: fixedAuth() });
    const result = await provider.run({ prompt: "p", cwd: "/", webSearchMaxUses: 2, onProgress: (n) => notes.push(n) });
    expect(result.text).toBe("cited answer");
    expect(notes).toContain("openai-codex → web search: top headline today");
    expect(notes.at(-1)).toBe("openai-codex: done (1 web search)");
  });

  it("degrades honestly when the endpoint refuses the search tool — never a silent clean run", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"detail":"Unsupported tool type: web_search"}', { status: 400 }))
      .mockResolvedValueOnce(sse(...completed("report without the sweep")));
    const provider = createOpenAICodexProvider({ env: {}, fetchImpl, codexAuth: fixedAuth() });
    const result = await provider.run({ prompt: "check the news", cwd: "/", webSearchMaxUses: 2 });
    const retry = JSON.parse(fetchImpl.mock.calls[1]![1].body);
    expect(retry.tools).toEqual([]);
    expect(retry.input[0].content[0].text).toContain("Web search is NOT available for this run");
    expect(result.degraded).toContain("rejected server-side web search");
  });

  it("an unrelated 400 is not mistaken for a tool rejection", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"detail":"Unsupported parameter: max_tool_calls"}', { status: 400 }));
    const provider = createOpenAICodexProvider({ env: {}, fetchImpl, codexAuth: fixedAuth() });
    await expect(provider.run({ prompt: "p", cwd: "/", webSearchMaxUses: 1 })).rejects.toThrow(/HTTP 400.*max_tool_calls/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is laptop-tier (Workers egress is blocked), and names the login it is missing", () => {
    expect(CLOUD_HARNESSES.has("openai-codex")).toBe(false);
    expect(() => createOpenAICodexProvider({ env: {} }).assertConfigured()).toThrow(/codex login.*CODEX_REFRESH_TOKEN/);
    expect(() => createOpenAICodexProvider({ env: { CODEX_REFRESH_TOKEN: "rt" } }).assertConfigured()).not.toThrow();
  });
});

describe("codex auth helpers (Workers-safe)", () => {
  it("with no context, only a static access token is used — never refreshed", async () => {
    const live = staticCodexAuth({ env: { CODEX_ACCESS_TOKEN: access(3600, "acct-s") }, now: () => NOW });
    expect((await live()).accountId).toBe("acct-s");
    const expired = staticCodexAuth({ env: { CODEX_ACCESS_TOKEN: access(-10) }, now: () => NOW });
    await expect(expired()).rejects.toThrow(/never refreshes/);
    await expect(live({ force: true })).rejects.toThrow(/never refreshes/);
  });

  it("reads the account id from either token's auth claim", () => {
    expect(accountIdFrom(undefined, "garbage", access(1, "acct-x"))).toBe("acct-x");
    expect(accountIdFrom("not.a-jwt.at-all")).toBeUndefined();
  });
});

describe("laptop Codex login: borrowed read-only, never refreshed", () => {
  const authFile = async (tokens: Record<string, unknown>) => {
    const root = await makeTree({
      "auth.json": JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens, last_refresh: "x" }),
    });
    return { root, file: path.join(root, "auth.json") };
  };

  it("hands out the CLI's access token and account, and never writes the shared file", async () => {
    const { root, file } = await authFile({ access_token: access(3600, "acct-cli"), refresh_token: "rt-cli", account_id: "acct-cli" });
    const before = readFileSync(file, "utf8");
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const auth = await fileCodexAuth({ CODEX_HOME: root }, () => NOW)();
      expect(auth).toEqual({ accessToken: access(3600, "acct-cli"), accountId: "acct-cli" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchImpl).not.toHaveBeenCalled(); // no refresh grant, ever
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("re-reads per call, so a refresh Codex did itself is picked up", async () => {
    const { root, file } = await authFile({ access_token: access(3600, "acct-1"), refresh_token: "rt" });
    const source = fileCodexAuth({ CODEX_HOME: root }, () => NOW);
    expect((await source()).accountId).toBe("acct-1");
    writeFileSync(file, JSON.stringify({ tokens: { access_token: access(7200, "acct-2"), refresh_token: "rt2" } }));
    expect((await source()).accountId).toBe("acct-2");
  });

  it("an expired token names the fix (use Codex once) instead of refreshing a shared login", async () => {
    const { root } = await authFile({ access_token: access(-60), refresh_token: "rt" });
    await expect(fileCodexAuth({ CODEX_HOME: root }, () => NOW)()).rejects.toThrow(/expired.*open Codex.*never refreshes/);
  });

  it("a 401-forced call fails with the fix rather than spending the refresh token", async () => {
    const { root } = await authFile({ access_token: access(3600), refresh_token: "rt" });
    await expect(fileCodexAuth({ CODEX_HOME: root }, () => NOW)({ force: true })).rejects.toThrow(/rejected.*never refreshes/);
  });

  it("no auth.json, or an API-key login, reads as no ChatGPT login", async () => {
    const empty = await makeTree({});
    await expect(fileCodexAuth({ CODEX_HOME: empty })()).rejects.toThrow(/no Codex login.*codex login/);
    writeFileSync(path.join(empty, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-key-login" }));
    await expect(fileCodexAuth({ CODEX_HOME: empty })()).rejects.toThrow(/no Codex login/);
  });
});
