import { getEnv } from "../instance/env-core.js";
import type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";
import type { ApiProviderContext } from "./moonshot-api.js";
import { staticCodexAuth, type CodexAuth } from "./codex-auth.js";

/**
 * `openai-codex` — the name the agent-tooling ecosystem settled on (OpenClaw,
 * pi-ai) for OpenAI models on a ChatGPT SUBSCRIPTION via Codex OAuth, as
 * opposed to plain `openai` (a metered API key). Should a metered OpenAI
 * harness ever land, it takes that other name.
 *
 * Codex (OpenAI) on a ChatGPT plan, over plain fetch — the API-shaped
 * sibling of the subprocess `codex` harness, the way `anthropic-api` is to
 * `claude-code`. It calls the Responses endpoint the Codex CLI itself uses
 * when logged in with ChatGPT, so usage draws on the plan's Codex quota
 * (shared with the operator's own Codex sessions), not metered API spend.
 *
 * LAPTOP-TIER, despite being pure fetch: chatgpt.com 403s Cloudflare Workers
 * egress by IP, so it is not in CLOUD_HARNESSES
 * (docs/learnings/2026-10-11-chatgpt-codex-blocks-workers.md).
 *
 * Wire shape, all verified live from a laptop 2026-10-11 (gpt-5.5 and
 * gpt-6-luna): bearer + `chatgpt-account-id`, system text in top-level
 * `instructions`, `store: false` and `stream: true` both REQUIRED.
 *
 * Auth comes from ctx.codexAuth: on the laptop, the operator's Codex login
 * borrowed READ-ONLY from auth.json and never refreshed (codex-auth-file.ts
 * says why). Without one, only a static CODEX_ACCESS_TOKEN is used.
 */
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
// The ChatGPT-plan default in the Codex CLI as of mid-2026; agents override with `model:`.
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000];
const INSTRUCTIONS = "You are an agent worker in an AnimaMesh mesh; return only your report body as markdown.";

const CAPABILITY_CORRECTION = (reason: string) =>
  `\n\n## Capability correction (harness, mid-run)\n\nWeb search is NOT available for this run after all: ${reason}. ` +
  `Do not describe any subject you meant to check as unchanged or clear — say plainly which checks could not run.`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class StreamError extends Error {}

/** Reduce a streamed Responses reply to its text, usage, and how it ended. */
export async function consumeResponsesSse(
  res: Response,
  onSearch: (query: string) => void = () => {},
): Promise<{ text: string; usage?: unknown; incomplete?: string; searches: number }> {
  const reader = res.body?.getReader();
  if (!reader) throw new StreamError("response had no body");
  const decoder = new TextDecoder();
  let buf = "";
  let deltas = "";
  const messages: string[] = [];
  let usage: unknown;
  let done: "completed" | "incomplete" | undefined;
  let incomplete: string | undefined;
  let searches = 0;

  const handle = (evt: Record<string, any>): void => {
    switch (evt.type) {
      case "response.output_text.delta":
        deltas += String(evt.delta ?? "");
        break;
      case "response.output_item.done": {
        const item = evt.item ?? {};
        if (item.type === "web_search_call") {
          searches += 1;
          onSearch(String(item.action?.query ?? item.action?.queries?.[0] ?? ""));
        }
        if (item.type === "message" && Array.isArray(item.content)) {
          const t = item.content
            .filter((c: any) => c?.type === "output_text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join("");
          if (t) messages.push(t);
        }
        break;
      }
      case "response.completed":
        usage = evt.response?.usage;
        done = "completed";
        break;
      case "response.incomplete":
        usage = evt.response?.usage;
        incomplete = String(evt.response?.incomplete_details?.reason ?? "unknown");
        done = "incomplete";
        break;
      case "response.failed":
        throw new StreamError(String(evt.response?.error?.message ?? "response failed"));
      case "error":
        throw new StreamError(String(evt.message ?? evt.error?.message ?? "stream error"));
      default:
        break;
    }
  };

  const feed = (chunk: string): void => {
    buf = (buf + chunk).replace(/\r\n/g, "\n");
    for (;;) {
      const sep = buf.indexOf("\n\n");
      if (sep === -1) return;
      const rawEvt = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let data = "";
      for (const line of rawEvt.split("\n")) if (line.startsWith("data:")) data += line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      handle(parsed);
    }
  };

  try {
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      feed(decoder.decode(value, { stream: true }));
      if (done) break;
    }
    feed(decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!done) throw new StreamError("stream ended before response.completed — the connection was cut mid-generation");
  // Completed message items are authoritative; deltas cover a backend that omits them.
  return { text: (messages.length ? messages.join("\n") : deltas).trim(), usage, incomplete, searches };
}

export function createOpenAICodexProvider(ctx: ApiProviderContext = {}): AgentWorkerProvider {
  const env = ctx.env ?? {};
  // Wrapped, never aliased: Workers reject a rebound `this` on global fetch.
  const doFetch = ctx.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const retryDelays = ctx.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const auth = ctx.codexAuth ?? staticCodexAuth({ env });

  return {
    name: "openai-codex",
    // No filesystem: the worker has only the prompt. Web search is the
    // endpoint's SERVER-SIDE `web_search` tool, answered inside the same
    // streamed response, so it works unchanged on Workers (probed live
    // 2026-10-11 on gpt-5.5: one web_search_call, cited answer). The
    // endpoint rejects `max_tool_calls` ("Unsupported parameter"), so the
    // `web:` budget is held by the prompt, as on the `codex` CLI harness.
    capabilities: { fileReads: false, webSearch: true },

    assertConfigured(): void {
      if (!ctx.codexAuth && !getEnv(env, "CODEX_ACCESS_TOKEN")) {
        throw new Error(
          "openai-codex harness: no Codex login — run `codex login` on the laptop (the engine borrows it read-only). Not available on the cloud tier: chatgpt.com blocks Workers egress",
        );
      }
    },

    async run(opts: ProviderRunOptions): Promise<ProviderResult> {
      const model = opts.model ?? DEFAULT_MODEL;
      const base = (getEnv(env, "CODEX_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
      const endpoint = `${base}/responses`;
      const progress = opts.onProgress ?? (() => {});
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const webUses = Math.max(0, Math.floor(opts.webSearchMaxUses ?? 0));
      let webEnabled = webUses > 0;
      let degraded: string | undefined;
      let prompt = opts.prompt;
      const bodyFor = () =>
        JSON.stringify({
          model,
          instructions: INSTRUCTIONS,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
          // Only an agent that budgets the web (`web:`) gets the tool.
          tools: webEnabled ? [{ type: "web_search" }] : [],
          tool_choice: "auto",
          parallel_tool_calls: false,
          store: false, // required by this endpoint
          stream: true, // required by this endpoint — and the 524 lesson applies anyway
        });
      const sessionId = crypto.randomUUID();

      progress(`openai-codex: starting (${model}${webEnabled ? `, web search ≤${webUses}` : ""})`);
      let creds: CodexAuth = await auth();
      let reauthed = false;
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${creds.accessToken}`,
              ...(creds.accountId ? { "chatgpt-account-id": creds.accountId } : {}),
              "openai-beta": "responses=experimental",
              originator: "anima-mesh",
              session_id: sessionId,
              accept: "text/event-stream",
              "content-type": "application/json",
            },
            body: bodyFor(),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === "TimeoutError") {
            throw new Error(`openai-codex run timed out after ${timeoutMs}ms`);
          }
          throw err;
        }

        if (res.ok) {
          let out: Awaited<ReturnType<typeof consumeResponsesSse>>;
          try {
            out = await consumeResponsesSse(res, (q) => progress(`openai-codex → web search: ${q.slice(0, 120)}`));
          } catch (err) {
            if (err instanceof DOMException && err.name === "TimeoutError") {
              throw new Error(`openai-codex run timed out after ${timeoutMs}ms`);
            }
            const msg = err instanceof Error ? err.message : String(err);
            if (attempt < retryDelays.length) {
              const delay = retryDelays[attempt]!;
              progress(`openai-codex: stream failed (${msg}) — retry ${attempt + 1}/${retryDelays.length} in ${delay}ms`);
              await sleep(delay);
              continue;
            }
            throw new Error(`openai-codex → stream failed after retries: ${msg}`);
          }
          if (!out.text) {
            throw new Error(
              `openai-codex → response contained no output text${out.incomplete ? ` (incomplete: ${out.incomplete})` : ""}`,
            );
          }
          progress(`openai-codex: done${out.searches ? ` (${out.searches} web search${out.searches === 1 ? "" : "es"})` : ""}`);
          const notes = [
            degraded,
            out.incomplete ? `response incomplete (${out.incomplete}) — this report may be cut short` : undefined,
          ].filter(Boolean);
          // costUsd unset: plan quota, not metered spend. The ledger stores tokens.
          return { text: out.text, tokens: out.usage, ...(notes.length ? { degraded: notes.join("; ") } : {}) };
        }

        const raw = await res.text().catch(() => "");
        // One forced refresh per run: a 401 on a token `exp` called fresh
        // means it was revoked or rotated out from under us.
        if (res.status === 401 && !reauthed) {
          reauthed = true;
          progress("openai-codex: HTTP 401 — refreshing the login once");
          creds = await auth({ force: true });
          attempt = -1;
          continue;
        }
        // The endpoint refusing the search tool must not take the run down,
        // and must never read as a clean run: rerun without it, tell the
        // agent so in the prompt, and record `degraded` (the anthropic-api
        // pattern, issue #4).
        if (webEnabled && res.status === 400 && /web_search|unsupported tool/i.test(raw)) {
          const reason = `the endpoint rejected server-side web search (HTTP 400: ${raw.slice(0, 160)})`;
          webEnabled = false;
          degraded = reason;
          prompt = opts.prompt + CAPABILITY_CORRECTION(reason);
          attempt = -1;
          progress("openai-codex: web search unavailable — rerunning without it and telling the agent so");
          continue;
        }
        let errBody = raw.trimStart().startsWith("<")
          ? "(HTML block page from the endpoint's edge — this network is blocked from calling the endpoint; the API itself was never reached)"
          : raw.slice(0, 200);
        if (res.status === 429) errBody += " [ChatGPT plan usage limit — shared with your own Codex sessions]";
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retryDelays.length) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const delay =
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelays[attempt]!;
          progress(`openai-codex: HTTP ${res.status}, retry ${attempt + 1}/${retryDelays.length} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new Error(`openai-codex → HTTP ${res.status}: ${errBody}`);
      }
    },
  };
}

/** Default instance: static-token only until a context supplies a token source. */
export const openaiCodexProvider = createOpenAICodexProvider();
