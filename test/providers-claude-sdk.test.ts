import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClaudeAgentSdkProvider } from "../src/providers/claude-agent-sdk.js";

/**
 * The SDK is mocked at the module boundary — these tests must never spawn
 * the bundled CLI. run() imports it lazily, which vi.mock intercepts.
 */
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    result: "  the brief  ",
    usage: { input_tokens: 100, output_tokens: 50 },
    total_cost_usd: 0.0123,
    ...overrides,
  };
}

/** query() returns an async iterable; the provider consumes it. */
function streamOf(...messages: unknown[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

const ENV = { CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token-not-real" };

beforeEach(() => {
  queryMock.mockReset();
  // Hermetic: a real token in the shell env must not mask the negative tests.
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("claude-agent-sdk provider", () => {
  it("calls query() with model, cwd, no settings bleed, and read-only tools", async () => {
    queryMock.mockReturnValue(streamOf({ type: "assistant" }, resultMessage()));
    const provider = createClaudeAgentSdkProvider({ env: ENV });

    await provider.run({ prompt: "the prompt", cwd: "/bundle/root", model: "sonnet" });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const { prompt, options } = queryMock.mock.calls[0]![0];
    expect(prompt).toBe("the prompt");
    expect(options.model).toBe("sonnet");
    expect(options.cwd).toBe("/bundle/root");
    expect(options.settingSources).toEqual([]);
    expect(options.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(options.maxTurns).toBe(25);
  });

  it("pins the ctx token into the subprocess env (SDK env replaces, not merges)", async () => {
    queryMock.mockReturnValue(streamOf(resultMessage()));
    const provider = createClaudeAgentSdkProvider({ env: ENV });

    await provider.run({ prompt: "p", cwd: "/" });

    const { options } = queryMock.mock.calls[0]![0];
    expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-oauth-token-not-real");
    // process.env was spread in, not replaced wholesale (PATH survives).
    expect(options.env.PATH).toBe(process.env.PATH);
  });

  it("maps a success result to text/tokens/costUsd", async () => {
    queryMock.mockReturnValue(streamOf(resultMessage()));
    const provider = createClaudeAgentSdkProvider({ env: ENV });

    const result = await provider.run({ prompt: "p", cwd: "/" });

    expect(result.text).toBe("the brief");
    expect(result.tokens).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(result.costUsd).toBe(0.0123);
  });

  it("throws naming the subtype on an error result", async () => {
    queryMock.mockReturnValue(
      streamOf(resultMessage({ subtype: "error_max_turns", result: undefined })),
    );
    const provider = createClaudeAgentSdkProvider({ env: ENV });

    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toThrow(/error_max_turns/);
  });

  it("throws if the stream ends without a result message", async () => {
    queryMock.mockReturnValue(streamOf({ type: "assistant" }));
    const provider = createClaudeAgentSdkProvider({ env: ENV });

    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toThrow(/without a result/);
  });

  it("assertConfigured throws without CLAUDE_CODE_OAUTH_TOKEN", () => {
    const provider = createClaudeAgentSdkProvider({ env: {} });
    expect(() => provider.assertConfigured()).toThrow(/CLAUDE_CODE_OAUTH_TOKEN.*setup-token/);
  });

  it("assertConfigured passes with the token in the injected env", () => {
    const provider = createClaudeAgentSdkProvider({ env: ENV });
    expect(() => provider.assertConfigured()).not.toThrow();
  });

  it("times out when no result arrives in time", async () => {
    queryMock.mockReturnValue(
      (async function* () {
        await new Promise(() => {}); // never settles — the race must win
        yield resultMessage();
      })(),
    );
    const provider = createClaudeAgentSdkProvider({ env: ENV });

    await expect(provider.run({ prompt: "p", cwd: "/", timeoutMs: 30 })).rejects.toThrow(
      /timed out after 30ms/,
    );
  });
});
