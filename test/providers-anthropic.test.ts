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
    expect(body.max_tokens).toBe(8192);
    // The OAuth gateway requires the system prompt to BEGIN with the
    // Claude Code identity sentence.
    expect(body.system.startsWith("You are Claude Code, Anthropic's official CLI for Claude.")).toBe(true);
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
