import { describe, it, expect, vi } from "vitest";
import { createMoonshotApiProvider } from "../src/providers/moonshot-api.js";
import { resolveProvider, CLOUD_HARNESSES } from "../src/providers/index.js";

/** A Response-shaped success payload the provider should parse. */
function okResponse(content = "report body", usage: unknown = { prompt_tokens: 10, completion_tokens: 20 }) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const ENV = { MOONSHOT_API_KEY: "test-key-not-real" };

describe("moonshot-api provider", () => {
  it("sends an OpenAI-compatible request and maps the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse("  the report  "));
    const provider = createMoonshotApiProvider({ env: ENV, fetchImpl });

    const result = await provider.run({ prompt: "do the thing", cwd: "/ignored", model: "kimi-k2.6" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-key-not-real");
    expect(init.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("kimi-k2.6");
    expect(body.max_tokens).toBe(8192);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1]).toEqual({ role: "user", content: "do the thing" });

    expect(result.text).toBe("the report");
    expect(result.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 20 });
    expect(result.costUsd).toBeUndefined();
  });

  it("assertConfigured throws without the key, naming the env var", () => {
    const provider = createMoonshotApiProvider({ env: { MOONSHOT_API_KEY: "" }, fetchImpl: vi.fn() });
    expect(() => provider.assertConfigured()).toThrow(/MOONSHOT_API_KEY/);
  });

  it("assertConfigured passes when the injected env has the key", () => {
    const provider = createMoonshotApiProvider({ env: ENV, fetchImpl: vi.fn() });
    expect(() => provider.assertConfigured()).not.toThrow();
  });

  it("throws on 401 with status and clipped body — no retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized: bad key", { status: 401 }));
    const provider = createMoonshotApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0, 0] });

    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toThrow(/HTTP 401: unauthorized/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries 429 then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(okResponse("after retry"));
    const provider = createMoonshotApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0, 0] });

    const result = await provider.run({ prompt: "p", cwd: "/" });
    expect(result.text).toBe("after retry");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries on persistent 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("still limited", { status: 429 }));
    const provider = createMoonshotApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0, 0] });

    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toThrow(/HTTP 429/);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("retries 5xx like 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 503 }))
      .mockResolvedValueOnce(okResponse("recovered"));
    const provider = createMoonshotApiProvider({ env: ENV, fetchImpl, retryDelaysMs: [0, 0] });

    const result = await provider.run({ prompt: "p", cwd: "/" });
    expect(result.text).toBe("recovered");
  });

  it("aborts on timeout", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const provider = createMoonshotApiProvider({ env: ENV, fetchImpl });

    await expect(provider.run({ prompt: "p", cwd: "/", timeoutMs: 25 })).rejects.toThrow(/timed out after 25ms/);
  });

  it("throws on a 200 with a malformed body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const provider = createMoonshotApiProvider({ env: ENV, fetchImpl });

    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toThrow(/malformed response/);
  });

  it("never leaks the key into error messages", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("denied", { status: 403 }));
    const provider = createMoonshotApiProvider({ env: ENV, fetchImpl });

    await expect(provider.run({ prompt: "p", cwd: "/" })).rejects.toSatisfy(
      (err: Error) => !err.message.includes("test-key-not-real"),
    );
  });
});

describe("provider registry", () => {
  it("resolves moonshot-api with an injected context", () => {
    const provider = resolveProvider("moonshot-api", { env: ENV });
    expect(provider.name).toBe("moonshot-api");
    expect(() => provider.assertConfigured()).not.toThrow();
  });

  it("resolves moonshot-api without context (process.env fallback instance)", () => {
    expect(resolveProvider("moonshot-api").name).toBe("moonshot-api");
  });

  it("CLOUD_HARNESSES contains exactly the fetch-only harnesses", () => {
    expect([...CLOUD_HARNESSES]).toEqual(["moonshot-api"]);
    expect(CLOUD_HARNESSES.has("claude-agent-sdk")).toBe(false);
    expect(CLOUD_HARNESSES.has("claude-code")).toBe(false);
    expect(CLOUD_HARNESSES.has("opencode")).toBe(false);
  });
});
