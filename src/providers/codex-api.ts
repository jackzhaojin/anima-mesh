import { getEnv } from "../instance/env-core.js";
import type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";
import type { ApiProviderContext } from "./moonshot-api.js";
import { staticCodexAuth, type CodexAuth } from "./codex-auth.js";

/**
 * Codex (OpenAI) on a ChatGPT plan, over plain fetch — the Workers-capable
 * sibling of the subprocess `codex` harness, the way `anthropic-api` is to
 * `claude-code`. It calls the Responses endpoint the Codex CLI itself uses
 * when logged in with ChatGPT, so usage draws on the plan's Codex quota
 * (shared with the operator's own Codex sessions), not metered API spend.
 *
 * Wire shape (from the Codex CLI's protocol and third-party clients of the
 * same endpoint; NOT yet probed live from Workers egress — see
 * docs/deploying-cloud.md): bearer + `chatgpt-account-id`, system text in
 * top-level `instructions`, `store: false` and `stream: true` both
 * REQUIRED (the endpoint 400s without either).
 *
 * Auth comes from ctx.codexAuth — the Worker passes a Durable-Object-backed
 * source and the laptop an auth.json-backed one, because ChatGPT refresh
 * tokens rotate (codex-auth.ts). Without one, only a static
 * CODEX_ACCESS_TOKEN is used, never refreshed.
 */
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
// The ChatGPT-plan default in the Codex CLI as of mid-2026; agents override with `model:`.
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000];
const INSTRUCTIONS = "You are an agent worker in an AnimaMesh mesh; return only your report body as markdown.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class StreamError extends Error {}

/** Reduce a streamed Responses reply to its text, usage, and how it ended. */
export async function consumeResponsesSse(
  res: Response,
): Promise<{ text: string; usage?: unknown; incomplete?: string }> {
  const reader = res.body?.getReader();
  if (!reader) throw new StreamError("response had no body");
  const decoder = new TextDecoder();
  let buf = "";
  let deltas = "";
  const messages: string[] = [];
  let usage: unknown;
  let done: "completed" | "incomplete" | undefined;
  let incomplete: string | undefined;

  const handle = (evt: Record<string, any>): void => {
    switch (evt.type) {
      case "response.output_text.delta":
        deltas += String(evt.delta ?? "");
        break;
      case "response.output_item.done": {
        const item = evt.item ?? {};
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
  return { text: (messages.length ? messages.join("\n") : deltas).trim(), usage, incomplete };
}

export function createCodexApiProvider(ctx: ApiProviderContext = {}): AgentWorkerProvider {
  const env = ctx.env ?? {};
  // Wrapped, never aliased: Workers reject a rebound `this` on global fetch.
  const doFetch = ctx.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const retryDelays = ctx.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const auth = ctx.codexAuth ?? staticCodexAuth({ env });

  return {
    name: "codex-api",
    // Plain Responses call with an empty tools array: the worker has only the
    // prompt. The endpoint's server-side `web_search` tool is not wired until
    // it has been probed live — claiming it unprobed would recreate issue #4.
    capabilities: { fileReads: false, webSearch: false },

    assertConfigured(): void {
      if (
        !ctx.codexAuth &&
        !getEnv(env, "CODEX_ACCESS_TOKEN") &&
        !getEnv(env, "CODEX_REFRESH_TOKEN")
      ) {
        throw new Error(
          "codex-api harness: no Codex login — `codex login` on the laptop, or CODEX_REFRESH_TOKEN (from a dedicated login) in Worker secrets",
        );
      }
    },

    async run(opts: ProviderRunOptions): Promise<ProviderResult> {
      const model = opts.model ?? DEFAULT_MODEL;
      const base = (getEnv(env, "CODEX_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
      const endpoint = `${base}/responses`;
      const progress = opts.onProgress ?? (() => {});
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const body = JSON.stringify({
        model,
        instructions: INSTRUCTIONS,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: opts.prompt }] }],
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false, // required by this endpoint
        stream: true, // required by this endpoint — and the 524 lesson applies anyway
      });
      const sessionId = crypto.randomUUID();

      progress(`codex-api: starting (${model})`);
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
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === "TimeoutError") {
            throw new Error(`codex-api run timed out after ${timeoutMs}ms`);
          }
          throw err;
        }

        if (res.ok) {
          let out: Awaited<ReturnType<typeof consumeResponsesSse>>;
          try {
            out = await consumeResponsesSse(res);
          } catch (err) {
            if (err instanceof DOMException && err.name === "TimeoutError") {
              throw new Error(`codex-api run timed out after ${timeoutMs}ms`);
            }
            const msg = err instanceof Error ? err.message : String(err);
            if (attempt < retryDelays.length) {
              const delay = retryDelays[attempt]!;
              progress(`codex-api: stream failed (${msg}) — retry ${attempt + 1}/${retryDelays.length} in ${delay}ms`);
              await sleep(delay);
              continue;
            }
            throw new Error(`codex-api → stream failed after retries: ${msg}`);
          }
          if (!out.text) {
            throw new Error(
              `codex-api → response contained no output text${out.incomplete ? ` (incomplete: ${out.incomplete})` : ""}`,
            );
          }
          progress("codex-api: done");
          // costUsd unset: plan quota, not metered spend. The ledger stores tokens.
          return {
            text: out.text,
            tokens: out.usage,
            ...(out.incomplete ? { degraded: `response incomplete (${out.incomplete}) — this report may be cut short` } : {}),
          };
        }

        const raw = await res.text().catch(() => "");
        // One forced refresh per run: a 401 on a token `exp` called fresh
        // means it was revoked or rotated out from under us.
        if (res.status === 401 && !reauthed) {
          reauthed = true;
          progress("codex-api: HTTP 401 — refreshing the login once");
          creds = await auth({ force: true });
          attempt = -1;
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
          progress(`codex-api: HTTP ${res.status}, retry ${attempt + 1}/${retryDelays.length} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new Error(`codex-api → HTTP ${res.status}: ${errBody}`);
      }
    },
  };
}

/** Default instance: static-token only until a context supplies a token source. */
export const codexApiProvider = createCodexApiProvider();
