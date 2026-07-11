import { getEnv } from "../instance/env-core.js";
import type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";

/**
 * Moonshot (Kimi) via the OpenAI-compatible chat completions API — pure
 * fetch, no subprocess, no filesystem: the cloud tier's cognition provider.
 * API providers are text-in/text-out; the harness assembles all context into
 * the prompt and writes all artifacts, so `cwd` is deliberately ignored.
 *
 * Auth: MOONSHOT_API_KEY, resolved from the injected env (instance .env on
 * the laptop, Worker secrets in the cloud) with process.env as fallback.
 */
export interface ApiProviderContext {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Test seam: override the 429/5xx backoff schedule (ms per retry). */
  retryDelaysMs?: number[];
}

// Open-platform default; MOONSHOT_BASE_URL overrides (e.g. the
// Kimi-for-Coding subscription endpoint https://api.kimi.com/coding/v1,
// whose keys are NOT valid on the open platform — verified 2026-07-11).
const DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";
// Verified against platform.moonshot.ai (now platform.kimi.ai) 2026-07-11.
const DEFAULT_MODEL = "kimi-k2.6";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000];
// One short line: the real instructions arrive in the harness-built prompt.
const SYSTEM_PROMPT =
  "You are an agent worker in an AnimaMesh mesh; return only your report body as markdown.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMoonshotApiProvider(ctx: ApiProviderContext = {}): AgentWorkerProvider {
  const env = ctx.env ?? {};
  const doFetch = ctx.fetchImpl ?? fetch;
  const retryDelays = ctx.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  return {
    name: "moonshot-api",

    assertConfigured(): void {
      if (!getEnv(env, "MOONSHOT_API_KEY")) {
        throw new Error(
          "moonshot-api harness: MOONSHOT_API_KEY is not set — add it to the instance .env.local (laptop) or Worker secrets (cloud)",
        );
      }
    },

    async run(opts: ProviderRunOptions): Promise<ProviderResult> {
      const key = getEnv(env, "MOONSHOT_API_KEY");
      if (!key) {
        throw new Error("moonshot-api harness: MOONSHOT_API_KEY is not set");
      }
      const model = opts.model ?? DEFAULT_MODEL;
      const base = (getEnv(env, "MOONSHOT_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
      const endpoint = `${base}/chat/completions`;
      const progress = opts.onProgress ?? (() => {});
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // No temperature: some models on these endpoints hard-reject anything
      // but their own default (kimi-for-coding 400s on 0.3 — found live).
      const body = JSON.stringify({
        model,
        max_tokens: 8192,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: opts.prompt },
        ],
      });

      progress(`moonshot-api: starting (${model})`);
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === "TimeoutError") {
            throw new Error(`moonshot-api run timed out after ${timeoutMs}ms`);
          }
          throw err;
        }

        if (res.ok) {
          const json = (await res.json()) as {
            choices?: Array<{ message?: { content?: unknown } }>;
            usage?: unknown;
          };
          const text = json.choices?.[0]?.message?.content;
          if (typeof text !== "string") {
            throw new Error("moonshot-api → malformed response: missing choices[0].message.content");
          }
          progress("moonshot-api: done");
          // costUsd deliberately unset: pricing drifts; the ledger stores tokens.
          return { text: text.trim(), raw: json, tokens: json.usage };
        }

        const raw = await res.text().catch(() => "");
        // An HTML body is an edge/WAF block page, not an API error — name it
        // instead of spraying markup into logs and channel replies. (Found
        // live 2026-07-11: api.kimi.com 403s ALL Cloudflare Workers egress
        // with a Cloudflare block page; the open platform does not.)
        const errBody = raw.trimStart().startsWith("<")
          ? "(HTML block page from the endpoint's edge — this network is blocked from calling the endpoint; the API itself was never reached)"
          : raw.slice(0, 200);
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retryDelays.length) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const delay =
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelays[attempt]!;
          progress(`moonshot-api: HTTP ${res.status}, retry ${attempt + 1}/${retryDelays.length} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new Error(`moonshot-api → HTTP ${res.status}: ${errBody}`);
      }
    },
  };
}

/** Default instance: env falls back to process.env (laptop CLI convenience). */
export const moonshotApiProvider = createMoonshotApiProvider();
