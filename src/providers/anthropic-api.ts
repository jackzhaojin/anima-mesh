import { getEnv } from "../instance/env-core.js";
import type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";
import type { ApiProviderContext } from "./moonshot-api.js";

/**
 * Claude via the Messages API over the SUBSCRIPTION OAuth token — pure
 * fetch, no subprocess, no filesystem: Workers-capable Claude cognition.
 *
 * Auth: CLAUDE_CODE_OAUTH_TOKEN (the `claude setup-token` credential) as a
 * Bearer with the `oauth-2025-04-20` beta header — the same wire calls the
 * Claude Code CLI makes. The gateway requires the system prompt to BEGIN
 * with the Claude Code identity sentence; the worker instruction rides
 * after it. Two operator-visible caveats, decided eyes-open (instance
 * decision 2026-07-11): usage shares the subscription's quota, and the
 * token is subscription-scoped — if the vendor tightens non-CLI use, this
 * provider 401s and the failure surfaces honestly.
 *
 * Proven from real Workers egress before this was written: api.anthropic.com
 * answers Workers fetch cleanly (unlike the Kimi edge, which WAF-blocks it).
 */

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000];
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";
// The gateway rejects OAuth-token requests whose system prompt doesn't
// start with this exact sentence.
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SYSTEM_PROMPT =
  `${IDENTITY}\n\nYou are an agent worker in an AnimaMesh mesh; return only your report body as markdown.`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createAnthropicApiProvider(ctx: ApiProviderContext = {}): AgentWorkerProvider {
  const env = ctx.env ?? {};
  const doFetch = ctx.fetchImpl ?? fetch;
  const retryDelays = ctx.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  return {
    name: "anthropic-api",

    assertConfigured(): void {
      if (!getEnv(env, "CLAUDE_CODE_OAUTH_TOKEN")) {
        throw new Error(
          "anthropic-api harness: CLAUDE_CODE_OAUTH_TOKEN is not set — add it to the instance .env.local (laptop) or Worker secrets (cloud)",
        );
      }
    },

    async run(opts: ProviderRunOptions): Promise<ProviderResult> {
      const token = getEnv(env, "CLAUDE_CODE_OAUTH_TOKEN");
      if (!token) {
        throw new Error("anthropic-api harness: CLAUDE_CODE_OAUTH_TOKEN is not set");
      }
      const model = opts.model ?? DEFAULT_MODEL;
      const base = (getEnv(env, "ANTHROPIC_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
      const endpoint = `${base}/v1/messages`;
      const progress = opts.onProgress ?? (() => {});
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const body = JSON.stringify({
        model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: opts.prompt }],
      });

      progress(`anthropic-api: starting (${model})`);
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "anthropic-version": ANTHROPIC_VERSION,
              "anthropic-beta": OAUTH_BETA,
              "content-type": "application/json",
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === "TimeoutError") {
            throw new Error(`anthropic-api run timed out after ${timeoutMs}ms`);
          }
          throw err;
        }

        if (res.ok) {
          const json = (await res.json()) as {
            content?: Array<{ type: string; text?: string }>;
            usage?: unknown;
          };
          const text = (json.content ?? [])
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("\n");
          if (!text) {
            throw new Error("anthropic-api → malformed response: no text content blocks");
          }
          progress("anthropic-api: done");
          // costUsd deliberately unset: subscription quota, not metered spend.
          return { text: text.trim(), raw: json, tokens: json.usage };
        }

        const raw = await res.text().catch(() => "");
        // An HTML body is an edge/WAF block page, not an API error — name it
        // (the api.kimi.com lesson, 2026-07-11).
        const errBody = raw.trimStart().startsWith("<")
          ? "(HTML block page from the endpoint's edge — this network is blocked from calling the endpoint; the API itself was never reached)"
          : raw.slice(0, 200);
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retryDelays.length) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const delay =
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelays[attempt]!;
          progress(`anthropic-api: HTTP ${res.status}, retry ${attempt + 1}/${retryDelays.length} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new Error(`anthropic-api → HTTP ${res.status}: ${errBody}`);
      }
    },
  };
}

/** Default instance: env falls back to process.env (laptop CLI convenience). */
export const anthropicApiProvider = createAnthropicApiProvider();
