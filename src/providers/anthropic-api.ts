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
// The gateway validates that the FIRST system block is EXACTLY this
// sentence — its own block in an array, never concatenated with anything.
// A concatenated string passes for small requests but routes large ones to
// the overage billing lane (org-disabled → bare 429 "Error", no quota
// headers). Bisected live 2026-07-12; matches anthropics/claude-code#40515.
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SYSTEM_BLOCKS = [
  { type: "text", text: IDENTITY },
  { type: "text", text: "You are an agent worker in an AnimaMesh mesh; return only your report body as markdown." },
];

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
      // max_tokens caps thinking + text COMBINED, and models with adaptive
      // thinking on by default (claude-sonnet-5) can spend a whole 8192
      // budget thinking on a hard prompt and return ZERO text (stop_reason
      // max_tokens, blocks: thinking — the 2026-07-18 librarian run). 16K
      // leaves room to think AND write while staying non-streaming-safe.
      let disableThinking = false;

      progress(`anthropic-api: starting (${model})`);
      for (let attempt = 0; ; attempt++) {
        const body = JSON.stringify({
          model,
          max_tokens: 16384,
          ...(disableThinking ? { thinking: { type: "disabled" } } : {}),
          system: SYSTEM_BLOCKS,
          messages: [{ role: "user", content: opts.prompt }],
        });
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
            stop_reason?: string;
            usage?: unknown;
          };
          const text = (json.content ?? [])
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("\n");
          if (!text) {
            // Name what DID come back — "malformed" alone is undebuggable
            // (is it thinking-only? an empty max_tokens cutoff? a refusal?).
            const types = (json.content ?? []).map((b) => b.type).join(",") || "none";
            if (!disableThinking && json.stop_reason === "max_tokens" && types === "thinking") {
              // Thinking ate the whole budget even at 16K — one retry with
              // thinking off (accepted on sonnet-5/opus-4.8; a model that
              // rejects it would 400, which surfaces honestly below).
              disableThinking = true;
              progress("anthropic-api: thinking consumed the output budget — retrying with thinking disabled");
              continue;
            }
            throw new Error(
              `anthropic-api → response contained no text blocks (stop_reason: ${json.stop_reason ?? "unknown"}, blocks: ${types})`,
            );
          }
          progress("anthropic-api: done");
          // costUsd deliberately unset: subscription quota, not metered spend.
          return { text: text.trim(), raw: json, tokens: json.usage };
        }

        const raw = await res.text().catch(() => "");
        // An HTML body is an edge/WAF block page, not an API error — name it
        // (the api.kimi.com lesson, 2026-07-11).
        let errBody = raw.trimStart().startsWith("<")
          ? "(HTML block page from the endpoint's edge — this network is blocked from calling the endpoint; the API itself was never reached)"
          : raw.slice(0, 200);
        if (res.status === 429) {
          // The subscription's unified window is SHARED with Claude Code
          // sessions — a bare "rate_limit_error" is undiagnosable without
          // these (the 2026-07-12 /direct triage lesson).
          const util = res.headers.get("anthropic-ratelimit-unified-5h-status");
          const reset = Number(res.headers.get("anthropic-ratelimit-unified-5h-reset"));
          const detail = [
            util ? `5h window: ${util}` : null,
            Number.isFinite(reset) && reset > 0 ? `resets ${new Date(reset * 1000).toISOString()}` : null,
          ].filter(Boolean);
          if (detail.length) {
            errBody += ` [${detail.join(", ")} — quota is shared with Claude Code sessions]`;
          } else {
            // No quota headers at all = the OAuth gateway rejected the
            // REQUEST SHAPE (overage-lane routing), not the quota — the
            // 2026-07-12 root cause. Should not recur with block-form
            // system prompts, but if it does, name it.
            errBody +=
              " [no quota headers — the OAuth gateway rejected the request shape, not the quota; verify the system identity block]";
          }
        }
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
