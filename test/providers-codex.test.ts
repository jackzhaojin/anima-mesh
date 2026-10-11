import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { codexExecArgs, parseCodexEvents } from "../src/providers/codex.js";
import { createCodexApiProvider } from "../src/providers/codex-api.js";
import {
  codexAuthSource,
  memoryTokenStore,
  staticCodexAuth,
  accountIdFrom,
  CODEX_TOKEN_URL,
} from "../src/providers/codex-auth.js";
import { authJsonTokenStore } from "../src/providers/codex-auth-file.js";
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

describe("codex-api (ChatGPT-plan Codex over fetch)", () => {
  it("sends the endpoint's required shape and reads the streamed reply", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sse(...completed("the report")));
    const provider = createCodexApiProvider({ env: {}, fetchImpl, codexAuth: fixedAuth() });

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
    const provider = createCodexApiProvider({ env: {}, fetchImpl, codexAuth: fixedAuth() });
    expect((await provider.run({ prompt: "p", cwd: "/" })).text).toBe("part two");
  });

  it("an incomplete response returns what it has, flagged degraded — never a clean run", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse(
        { type: "response.output_text.delta", delta: "half" },
        { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
      ),
    );
    const provider = createCodexApiProvider({ env: {}, fetchImpl, codexAuth: fixedAuth() });
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
    const provider = createCodexApiProvider({ env: {}, fetchImpl, codexAuth: fixedAuth(), retryDelaysMs: [0] });
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
    const provider = createCodexApiProvider({ env: {}, fetchImpl, codexAuth });
    expect((await provider.run({ prompt: "p", cwd: "/" })).text).toBe("ok");
    expect(codexAuth.mock.calls[1]![0]).toEqual({ force: true });
    expect(fetchImpl.mock.calls[1]![1].headers.authorization).toBe("Bearer fresh");
  });

  it("a second 401 fails loud instead of looping on refreshes", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("unauthorized", { status: 401 }));
    const codexAuth = fixedAuth();
    const provider = createCodexApiProvider({ env: {}, fetchImpl, codexAuth, retryDelaysMs: [0, 0] });
    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toThrow(/codex-api → HTTP 401/);
    expect(codexAuth).toHaveBeenCalledTimes(2);
  });

  it("names the plan's usage limit on 429 and an edge block page on HTML", async () => {
    const limited = vi.fn().mockImplementation(async () => new Response('{"error":{"type":"usage_limit_reached"}}', { status: 429 }));
    const p1 = createCodexApiProvider({ env: {}, fetchImpl: limited, codexAuth: fixedAuth(), retryDelaysMs: [0] });
    await expect(p1.run({ prompt: "p", cwd: "/" })).rejects.toThrow(/ChatGPT plan usage limit/);

    const blocked = vi.fn().mockResolvedValue(new Response("<!DOCTYPE html><html>challenge", { status: 403 }));
    const p2 = createCodexApiProvider({ env: {}, fetchImpl: blocked, codexAuth: fixedAuth() });
    const err = (await p2.run({ prompt: "p", cwd: "/" }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("HTML block page");
    expect(err.message).not.toContain("DOCTYPE");
  });

  it("CODEX_BASE_URL overrides the endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sse(...completed("ok")));
    const provider = createCodexApiProvider({
      env: { CODEX_BASE_URL: "https://fake-codex.test/" },
      fetchImpl,
      codexAuth: fixedAuth(),
    });
    await provider.run({ prompt: "p", cwd: "/" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://fake-codex.test/responses");
  });

  it("under-claims web search until it has been probed live", () => {
    expect(createCodexApiProvider({ env: {} }).capabilities).toEqual({ fileReads: false, webSearch: false });
  });

  it("is a cloud harness, and names the login it is missing", () => {
    expect(CLOUD_HARNESSES.has("codex-api")).toBe(true);
    expect(() => createCodexApiProvider({ env: {} }).assertConfigured()).toThrow(/codex login.*CODEX_REFRESH_TOKEN/);
    expect(() => createCodexApiProvider({ env: { CODEX_REFRESH_TOKEN: "rt" } }).assertConfigured()).not.toThrow();
  });
});

/**
 * Rotating refresh tokens: the property under test is "never present a spent
 * refresh token" — persist before use, serialize refreshes, honor re-seeds.
 */
describe("codex auth — rotating ChatGPT refresh tokens", () => {
  const refreshOk = (n: number) =>
    new Response(JSON.stringify({ access_token: access(3600, `acct-${n}`), refresh_token: `rt-${n}` }), {
      status: 200,
    });

  it("seeds from CODEX_REFRESH_TOKEN, refreshes, and persists the ROTATED token", async () => {
    const store = memoryTokenStore();
    const fetchImpl = vi.fn().mockResolvedValue(refreshOk(2));
    const source = codexAuthSource(store, { env: { CODEX_REFRESH_TOKEN: "rt-1" }, fetchImpl, now: () => NOW });

    const auth = await source();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(CODEX_TOKEN_URL);
    const form = new URLSearchParams(init.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-1");
    expect(form.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(auth.accountId).toBe("acct-2");
    expect((await store.load())?.refreshToken).toBe("rt-2");
    expect((await store.load())?.seededFrom).toBe("rt-1");
  });

  it("reuses a fresh access token without touching the refresh token", async () => {
    const store = memoryTokenStore({ refreshToken: "rt-9", accessToken: access(3600) });
    const fetchImpl = vi.fn();
    const auth = await codexAuthSource(store, { env: {}, fetchImpl, now: () => NOW })();
    expect(auth.accountId).toBe("acct-1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes inside the expiry skew, and on force even when exp looks fine", async () => {
    const store = memoryTokenStore({ refreshToken: "rt-1", accessToken: access(60) });
    const fetchImpl = vi.fn().mockImplementation(async () => refreshOk(2));
    const source = codexAuthSource(store, { env: {}, fetchImpl, now: () => NOW });
    await source();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await source({ force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URLSearchParams(fetchImpl.mock.calls[1]![1].body).get("refresh_token")).toBe("rt-2");
  });

  it("concurrent callers share ONE refresh — a second would present a spent token", async () => {
    const store = memoryTokenStore({ refreshToken: "rt-1" });
    let n = 1;
    const fetchImpl = vi.fn().mockImplementation(async () => refreshOk(++n));
    const source = codexAuthSource(store, { env: {}, fetchImpl, now: () => NOW });
    const [a, b] = await Promise.all([source(), source()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe(b.accessToken);
  });

  it("a re-seeded secret (new dedicated login) replaces the stored chain", async () => {
    const store = memoryTokenStore({ refreshToken: "rt-old-chain", seededFrom: "seed-old", accessToken: access(3600) });
    const fetchImpl = vi.fn().mockResolvedValue(refreshOk(5));
    await codexAuthSource(store, { env: { CODEX_REFRESH_TOKEN: "seed-new" }, fetchImpl, now: () => NOW })();
    expect(new URLSearchParams(fetchImpl.mock.calls[0]![1].body).get("refresh_token")).toBe("seed-new");
    expect((await store.load())?.seededFrom).toBe("seed-new");
  });

  it("names a spent refresh token and the dedicated-login fix", async () => {
    const store = memoryTokenStore({ refreshToken: "rt-1" });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('{"error":"invalid_grant","error_description":"refresh_token_reused"}', { status: 400 }),
    );
    const err = (await codexAuthSource(store, { env: {}, fetchImpl, now: () => NOW })().catch((e: Error) => e)) as Error;
    expect(err.message).toContain("already spent or revoked");
    expect(err.message).toContain("OWN `codex login`");
    expect((await store.load())?.refreshToken).toBe("rt-1"); // nothing overwritten on failure
  });

  it("with no store, only a static access token is used — never a refresh it cannot remember", async () => {
    const live = staticCodexAuth({ env: { CODEX_ACCESS_TOKEN: access(3600, "acct-s") }, now: () => NOW });
    expect((await live()).accountId).toBe("acct-s");
    const expired = staticCodexAuth({ env: { CODEX_ACCESS_TOKEN: access(-10) }, now: () => NOW });
    await expect(expired()).rejects.toThrow(/no persistent token store/);
  });

  it("reads the account id from either token's auth claim", () => {
    expect(accountIdFrom(undefined, "garbage", access(1, "acct-x"))).toBe("acct-x");
    expect(accountIdFrom("not.a-jwt.at-all")).toBeUndefined();
  });
});

describe("codex auth.json store (laptop: shares the CLI's own login)", () => {
  it("round-trips tokens and preserves every field it does not own", async () => {
    const root = await makeTree({
      "auth.json": JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: { id_token: "id-1", access_token: "at-1", refresh_token: "rt-1", account_id: "acct-1" },
        last_refresh: "2026-01-01T00:00:00Z",
      }),
    });
    const file = path.join(root, "auth.json");
    const store = authJsonTokenStore(file);
    expect(await store.load()).toEqual({
      refreshToken: "rt-1",
      accessToken: "at-1",
      idToken: "id-1",
      accountId: "acct-1",
    });

    await store.save({ refreshToken: "rt-2", accessToken: "at-2", accountId: "acct-1" });
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.OPENAI_API_KEY).toBeNull();
    expect(written.tokens).toEqual({ id_token: "id-1", access_token: "at-2", refresh_token: "rt-2", account_id: "acct-1" });
    expect(written.last_refresh).not.toBe("2026-01-01T00:00:00Z");
  });

  it("a missing auth.json reads as no login, never as an error", async () => {
    const root = await makeTree({});
    expect(await authJsonTokenStore(path.join(root, "auth.json")).load()).toBeUndefined();
    writeFileSync(path.join(root, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-key-login" }));
    expect(await authJsonTokenStore(path.join(root, "auth.json")).load()).toBeUndefined();
  });
});
