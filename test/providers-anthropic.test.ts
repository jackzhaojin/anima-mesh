import { describe, it, expect, vi } from "vitest";
import { createAnthropicApiProvider } from "../src/providers/anthropic-api.js";
import { resolveProvider, CLOUD_HARNESSES } from "../src/providers/index.js";

/** A Messages-API-shaped success payload. */
function okResponse(text = "report body", usage: unknown = { input_tokens: 10, output_tokens: 20 }) {
  return new Response(JSON.stringify({ content: [{ type: "text", text }], usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const ENV = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-not-real" };

describe("anthropic-api provider (subscription OAuth over plain fetch)", () => {
  it("sends the OAuth-shaped Messages request and maps the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse("  the report  "));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl });

    const result = await provider.run({ prompt: "do the thing", cwd: "/ignored", model: "claude-sonnet-5" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer sk-ant-oat01-test-not-real");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(init.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-sonnet-5");
    // 16K, not 8K: max_tokens caps thinking + text combined, and adaptive
    // thinking (on by default on claude-sonnet-5) can eat a small budget
    // whole on hard prompts (the 2026-07-18 librarian lesson).
    expect(body.max_tokens).toBe(16384);
    // Streamed, always: a non-streaming call caps generation at the edge's
    // ~100s completion timeout — the 2026-08-01 HTTP 524 beat failure.
    expect(body.stream).toBe(true);
    expect(body.thinking).toBeUndefined(); // adaptive by default — never sent unless the fallback fires
    // The OAuth gateway validates the FIRST system block is EXACTLY the
    // Claude Code identity sentence — its own array entry, nothing appended.
    // Concatenating routes large requests to the disabled overage lane
    // (bare 429 "Error") — bisected live 2026-07-12.
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0]).toEqual({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    });
    for (const block of body.system.slice(1)) {
      expect(block.text).not.toContain("You are Claude Code");
    }
    expect(body.messages).toEqual([{ role: "user", content: "do the thing" }]);

    expect(result.text).toBe("the report");
    expect(result.tokens).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(result.costUsd).toBeUndefined(); // subscription quota, not metered spend
  });

  it("concatenates multiple text blocks and ignores non-text blocks", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "part one" },
            { type: "text", text: "part two" },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl });
    const result = await provider.run({ prompt: "p", cwd: "/" });
    expect(result.text).toBe("part one\npart two");
  });

  it("retries once with thinking disabled when thinking eats the whole output budget", async () => {
    // The 2026-07-18 librarian failure: adaptive thinking (default on
    // claude-sonnet-5) spent every output token, leaving zero text blocks.
    const thinkingOnly = new Response(
      JSON.stringify({ content: [{ type: "thinking", thinking: "" }], stop_reason: "max_tokens" }),
      { status: 200 },
    );
    const fetchImpl = vi.fn().mockResolvedValueOnce(thinkingOnly).mockResolvedValueOnce(okResponse("report"));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl });
    const result = await provider.run({ prompt: "p", cwd: "/" });
    expect(result.text).toBe("report");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).thinking).toBeUndefined();
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body).thinking).toEqual({ type: "disabled" });
  });

  it("a thinking-only response still fails loud when the retry also returns no text", async () => {
    const thinkingOnly = () =>
      new Response(
        JSON.stringify({ content: [{ type: "thinking", thinking: "" }], stop_reason: "max_tokens" }),
        { status: 200 },
      );
    const fetchImpl = vi.fn().mockResolvedValueOnce(thinkingOnly()).mockResolvedValueOnce(thinkingOnly());
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl });
    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toThrow(
      /no text blocks \(stop_reason: max_tokens, blocks: thinking\)/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("ANTHROPIC_BASE_URL overrides the endpoint (test/dev seam)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const provider = createAnthropicApiProvider({
      env: { ...ENV, ANTHROPIC_BASE_URL: "https://fake-anthropic.test/" },
      fetchImpl,
    });
    await provider.run({ prompt: "p", cwd: "/" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://fake-anthropic.test/v1/messages");
  });

  it("assertConfigured names the env var when the token is missing", () => {
    const provider = createAnthropicApiProvider({ env: { CLAUDE_CODE_OAUTH_TOKEN: "" }, fetchImpl: vi.fn() });
    expect(() => provider.assertConfigured()).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("throws on 401 with clipped body — no retry (a revoked/tightened token fails loud)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("OAuth token rejected", { status: 401 }));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0, 0] });
    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toThrow(/HTTP 401: OAuth token rejected/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a 429 names the shared window and its reset time — never a bare 'Error'", async () => {
    // Fresh Response per attempt — a reused one has a consumed body on retry.
    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response('{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}', {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-5h-reset": "1783906200",
        },
      }),
    );
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0] });
    const err = await provider.run({ prompt: "p", cwd: "/" }).catch((e: Error) => e);
    expect((err as Error).message).toContain("HTTP 429");
    expect((err as Error).message).toContain("rate_limit_error");
    expect((err as Error).message).toContain("5h window: rejected");
    expect((err as Error).message).toContain("resets 2026-07-13T01:30:00.000Z");
    expect((err as Error).message).toContain("shared with Claude Code sessions");
  });

  it("a 429 WITHOUT quota headers names the request-shape rejection (the 2026-07-12 root cause)", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response('{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}', { status: 429 }),
    );
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0] });
    const err = await provider.run({ prompt: "p", cwd: "/" }).catch((e: Error) => e);
    expect((err as Error).message).toContain("HTTP 429");
    expect((err as Error).message).toContain("rejected the request shape");
    expect((err as Error).message).toContain("system identity block");
  });

  it("retries 429/5xx then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 529 }))
      .mockResolvedValueOnce(okResponse("after retry"));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0, 0] });
    const result = await provider.run({ prompt: "p", cwd: "/" });
    expect(result.text).toBe("after retry");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("names an HTML block page instead of spraying markup (the api.kimi.com lesson)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<!DOCTYPE html><html>blocked SECRET", { status: 403 }));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0, 0] });
    const err = await provider.run({ prompt: "p", cwd: "/" }).catch((e: Error) => e);
    expect((err as Error).message).toContain("HTML block page");
    expect((err as Error).message).not.toContain("DOCTYPE");
    expect((err as Error).message).not.toContain("SECRET");
  });

  it("never leaks the token into error messages", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 400 }));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0, 0] });
    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toSatisfy(
      (e: Error) => !e.message.includes("sk-ant-oat01-test-not-real"),
    );
  });

  it("is a cloud harness, resolvable with an injected context", () => {
    expect(CLOUD_HARNESSES.has("anthropic-api")).toBe(true);
    const provider = resolveProvider("anthropic-api", { env: ENV });
    expect(provider.name).toBe("anthropic-api");
    expect(() => provider.assertConfigured()).not.toThrow();
  });
});

/**
 * Server-side web search — the capability whose ABSENCE was issue #4. It runs
 * inside the API call, so the cloud tier gets real external checks without a
 * client tool loop or a subprocess.
 */
describe("anthropic-api — server-side web search", () => {
  const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) =>
    JSON.parse(fetchImpl.mock.calls[call]![1].body);

  it("sends no tools array at all when the agent has no web budget", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl });
    await provider.run({ prompt: "p", cwd: "/" });
    expect(bodyOf(fetchImpl).tools).toBeUndefined();
  });

  it("declares the capability, and spends exactly the budget it was given", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse("digest"));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl });
    expect(provider.capabilities).toEqual({ fileReads: false, webSearch: true });

    const result = await provider.run({ prompt: "p", cwd: "/", webSearchMaxUses: 8 });

    expect(bodyOf(fetchImpl).tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 8 },
    ]);
    expect(result.text).toBe("digest");
    expect(result.degraded).toBeUndefined();
  });

  it("continues a paused turn and keeps the text written before the pause", async () => {
    const paused = new Response(
      JSON.stringify({
        content: [
          { type: "text", text: "checked Adobe:" },
          { type: "server_tool_use", id: "srv_1", name: "web_search" },
        ],
        stop_reason: "pause_turn",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const fetchImpl = vi.fn().mockResolvedValueOnce(paused).mockResolvedValueOnce(okResponse("no releases"));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl });

    const result = await provider.run({ prompt: "sweep", cwd: "/", webSearchMaxUses: 5 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The continuation replays the paused turn's own content — that IS how
    // the search resumes; dropping it restarts the sweep from nothing.
    const second = bodyOf(fetchImpl, 1);
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1].role).toBe("assistant");
    expect(second.messages[1].content[1].name).toBe("web_search");
    // Nothing written before the pause is thrown away.
    expect(result.text).toBe("checked Adobe:\nno releases");
  });

  it("degrades honestly when the gateway refuses server tools — never a silent clean run", async () => {
    const rejection = new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "web_search tool not permitted" } }),
      { status: 400 },
    );
    const fetchImpl = vi.fn().mockResolvedValueOnce(rejection).mockResolvedValueOnce(okResponse("internal-only digest"));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0, 0] });

    const result = await provider.run({ prompt: "sweep the pillars", cwd: "/", webSearchMaxUses: 8 });

    // The beat survives — a digest without its web sweep still carries the
    // internal analysis...
    expect(result.text).toBe("internal-only digest");
    // ...but the run is marked degraded for the ledger...
    expect(result.degraded).toContain("rejected server-side web search");
    // ...and the AGENT is told mid-run, so it reports "could not check"
    // rather than "nothing changed" — the whole point of issue #4.
    const retryBody = bodyOf(fetchImpl, 1);
    expect(retryBody.tools).toBeUndefined();
    expect(retryBody.messages[0].content).toContain("sweep the pillars");
    expect(retryBody.messages[0].content).toContain("Capability correction");
    expect(retryBody.messages[0].content).toContain("Web search is NOT available");
  });

  it("returns what it gathered when a sweep never converges, flagged as degraded", async () => {
    const paused = () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "partial" }], stop_reason: "pause_turn" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetchImpl = vi.fn().mockImplementation(async () => paused());
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl });

    const result = await provider.run({ prompt: "p", cwd: "/", webSearchMaxUses: 8 });

    expect(result.degraded).toContain("did not converge");
    expect(result.text).toContain("partial");
  });

});

/**
 * The streamed (SSE) response path — the PRODUCTION path since the 2026-08-01
 * HTTP 524 beat failure. api.anthropic.com's edge kills any response that
 * has not COMPLETED within ~100s; only a streamed response can outlive that.
 * The JSON fixtures above exercise the fallback seam; these exercise the
 * reassembly the real API path runs through.
 */
describe("anthropic-api — streamed responses", () => {
  const sse = (events: Array<Record<string, unknown>>) =>
    new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const okStream = (chunks: string[]) =>
    sse([
      { type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ...chunks.map((text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ]);

  it("reassembles text deltas and merges usage from message_start + message_delta", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okStream(["the re", "port"]));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl });
    const result = await provider.run({ prompt: "p", cwd: "/" });
    expect(result.text).toBe("the report");
    expect(result.tokens).toEqual({ input_tokens: 10, output_tokens: 20 });
  });

  it("reconstructs a paused turn's blocks — server_tool_use input included — for the replay", async () => {
    // The continuation replays assistant content verbatim; a tool input lost
    // in reassembly would restart the sweep from nothing.
    const pausedStream = sse([
      { type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "checked Adobe:" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"adobe releases"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "pause_turn" } },
      { type: "message_stop" },
    ]);
    const fetchImpl = vi.fn().mockResolvedValueOnce(pausedStream).mockResolvedValueOnce(okStream(["no releases"]));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl });

    const result = await provider.run({ prompt: "sweep", cwd: "/", webSearchMaxUses: 5 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const second = JSON.parse(fetchImpl.mock.calls[1]![1].body);
    expect(second.messages[1].role).toBe("assistant");
    expect(second.messages[1].content[1].name).toBe("web_search");
    expect(second.messages[1].content[1].input).toEqual({ query: "adobe releases" });
    expect(result.text).toBe("checked Adobe:\nno releases");
  });

  it("a mid-stream error event retries like a 5xx, then succeeds", async () => {
    const errored = sse([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ]);
    const fetchImpl = vi.fn().mockResolvedValueOnce(errored).mockResolvedValueOnce(okStream(["after retry"]));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0, 0] });
    const result = await provider.run({ prompt: "p", cwd: "/" });
    expect(result.text).toBe("after retry");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a stream cut before message_stop never returns as a silent half-report", async () => {
    const cut = () =>
      sse([
        { type: "message_start", message: { role: "assistant", content: [] } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half a brie" } },
      ]);
    const fetchImpl = vi.fn().mockImplementation(async () => cut());
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0] });
    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toThrow(/cut mid-generation/);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the cut is retried before failing loud
  });
});

describe("anthropic-api — retry budget shape (JSON seam)", () => {
  it("keeps the HTTP retry budget per request, not per turn", async () => {
    // A paused turn followed by a transient 529 must still get its retries —
    // otherwise a long sweep spends the retry budget on its own progress.
    const paused = new Response(
      JSON.stringify({ content: [{ type: "text", text: "a" }], stop_reason: "pause_turn" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(paused)
      .mockResolvedValueOnce(new Response("overloaded", { status: 529 }))
      .mockResolvedValueOnce(new Response("overloaded", { status: 529 }))
      .mockResolvedValueOnce(okResponse("b"));
    const provider = createAnthropicApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0, 0] });

    const result = await provider.run({ prompt: "p", cwd: "/", webSearchMaxUses: 3 });
    expect(result.text).toBe("a\nb");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
