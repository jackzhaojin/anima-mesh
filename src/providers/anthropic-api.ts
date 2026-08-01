import { getEnv } from "../instance/env-core.js";
import type {
  AgentWorkerProvider,
  ProviderRunOptions,
  ProviderResult,
  ProviderCapabilities,
} from "./types.js";
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
 *
 * Requests are STREAMED (SSE), not buffered. api.anthropic.com sits behind
 * Cloudflare, whose edge returns HTTP 524 when the origin has not COMPLETED
 * a response within ~100s — a non-streaming call therefore hard-caps
 * generation time at 100s regardless of any client timeout. A long prompt
 * plus adaptive thinking blew through that on 2026-08-01 (three ~100s
 * attempts, three 524s, a failed beat). Streaming starts bytes flowing at
 * message_start, so the edge never sees a silent connection; the events are
 * reassembled below into the same message shape the non-streaming path
 * returned, and every downstream behavior (pause_turn, thinking fallback,
 * degradation) is unchanged. Non-SSE JSON responses are still accepted as a
 * fallback seam (fakes/tests, or a gateway that ignores `stream`).
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
// Server-side web search: the API runs the searches and returns results in
// the SAME response — no client tool loop, no subprocess, so it works
// unchanged on Workers. This is the only web capability any cloud-tier agent
// has ever had; before it, "budget ~8 web fetches" in an agent's job was
// instructions for a tool that did not exist (issue #4).
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
// Server tools can hand the turn back mid-search (`stop_reason: pause_turn`)
// on long sweeps; continuing the SAME conversation is how the search finishes.
const MAX_TURNS = 6;
// A run that trips this many pause_turns has stopped converging; the text
// gathered so far is still returned rather than thrown away.
const CAPABILITY_CORRECTION = (reason: string) =>
  `\n\n## Capability correction (harness, mid-run)\n\nWeb search is NOT available for this run after all: ${reason}. ` +
  `Do not describe any subject you meant to check as unchanged or clear — say plainly which checks could not run.`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The message shape both response paths (SSE, JSON) reduce to. */
type MessageJson = {
  content?: Array<Record<string, unknown> & { type: string; text?: string }>;
  stop_reason?: string | null;
  usage?: Record<string, unknown>;
};

/** A failure that arrived AFTER HTTP 200 (mid-stream) — retryable like a 5xx. */
class StreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamError";
  }
}

/**
 * Reassemble a streamed Messages response into the complete message JSON.
 * Fidelity matters beyond the text blocks: a pause_turn continuation replays
 * the assistant content verbatim, so server_tool_use inputs (input_json_delta)
 * and thinking signatures (signature_delta) must survive reconstruction.
 */
async function consumeSse(res: Response): Promise<MessageJson> {
  const reader = res.body?.getReader();
  if (!reader) throw new StreamError("response had no body");
  const decoder = new TextDecoder();
  let buf = "";
  let message: MessageJson | undefined;
  const partialJson = new Map<number, string>();
  let sawStop = false;

  const handle = (evt: Record<string, any>): void => {
    switch (evt.type) {
      case "message_start": {
        const m = evt.message ?? {};
        message = { ...m, content: Array.isArray(m.content) ? [...m.content] : [] };
        break;
      }
      case "content_block_start": {
        if (!message) break;
        const block = { ...(evt.content_block ?? {}) };
        if (block.type === "text" && typeof block.text !== "string") block.text = "";
        message.content![Number(evt.index)] = block;
        break;
      }
      case "content_block_delta": {
        const idx = Number(evt.index);
        const block = message?.content?.[idx] as Record<string, any> | undefined;
        const delta = evt.delta ?? {};
        if (!block) break;
        if (delta.type === "text_delta") block.text = (block.text ?? "") + delta.text;
        else if (delta.type === "thinking_delta") block.thinking = (block.thinking ?? "") + delta.thinking;
        else if (delta.type === "signature_delta") block.signature = (block.signature ?? "") + delta.signature;
        else if (delta.type === "input_json_delta")
          partialJson.set(idx, (partialJson.get(idx) ?? "") + delta.partial_json);
        else if (delta.type === "citations_delta" && delta.citation)
          block.citations = [...(block.citations ?? []), delta.citation];
        break;
      }
      case "content_block_stop": {
        const idx = Number(evt.index);
        const partial = partialJson.get(idx);
        if (partial !== undefined) {
          partialJson.delete(idx);
          try {
            (message?.content?.[idx] as Record<string, unknown>).input = JSON.parse(partial || "{}");
          } catch {
            // keep the start block's input rather than corrupt the replay
          }
        }
        break;
      }
      case "message_delta": {
        if (!message) break;
        Object.assign(message, evt.delta ?? {});
        if (evt.usage) message.usage = { ...(message.usage ?? {}), ...evt.usage };
        break;
      }
      case "message_stop":
        sawStop = true;
        break;
      case "error": {
        const e = evt.error ?? {};
        throw new StreamError(`${e.type ?? "error"}: ${e.message ?? "(no message)"}`);
      }
      default:
        break; // ping and future event types
    }
  };

  const feed = (text: string): void => {
    // Events are blank-line-separated; normalizing CRLF over the whole buffer
    // also heals a \r\n split across chunk boundaries (buf stays small —
    // complete events are consumed out of it immediately).
    buf = (buf + text).replace(/\r\n/g, "\n");
    for (;;) {
      const sep = buf.indexOf("\n\n");
      if (sep === -1) return;
      const rawEvt = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let data = "";
      for (const line of rawEvt.split("\n")) {
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // a malformed frame is dropped, not fatal — message_stop still gates completeness
      }
      handle(parsed);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
      if (sawStop) break;
    }
    feed(decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!message) throw new StreamError("stream ended before message_start");
  if (!sawStop)
    throw new StreamError("stream ended before message_stop — the connection was cut mid-generation");
  return message;
}

/** SSE when the API streams (the production path); plain JSON otherwise. */
async function readMessage(res: Response): Promise<MessageJson> {
  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ctype.includes("text/event-stream")) return consumeSse(res);
  return (await res.json()) as MessageJson;
}

/** A 400 that names the tool = this credential/gateway won't run server tools. */
function isToolRejection(status: number, body: string): boolean {
  if (status !== 400) return false;
  const b = body.toLowerCase();
  return b.includes("web_search") || b.includes("tool");
}

export function createAnthropicApiProvider(ctx: ApiProviderContext = {}): AgentWorkerProvider {
  const env = ctx.env ?? {};
  const doFetch = ctx.fetchImpl ?? fetch;
  const retryDelays = ctx.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  const capabilities: ProviderCapabilities = {
    // Pure Messages API: no filesystem, no shell — only what the prompt carries.
    fileReads: false,
    // Server-side, so it survives the Workers constraint that killed every
    // client-loop option.
    webSearch: true,
  };

  return {
    name: "anthropic-api",
    capabilities,

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
      // leaves room to think AND write; the streamed response (see header)
      // is what makes a generation that long survive the edge's ~100s
      // completion timeout (the 2026-08-01 HTTP 524 beat failure).
      let disableThinking = false;
      // Server-tool state. `webUses > 0` is the agent concept's `web:` budget,
      // already reconciled against this provider's capabilities by the harness.
      const webUses = Math.max(0, Math.floor(opts.webSearchMaxUses ?? 0));
      let webEnabled = webUses > 0;
      let degraded: string | undefined;
      // The conversation, not a single message: server tools may pause the
      // turn, and continuing requires replaying what came back.
      let userPrompt = opts.prompt;
      let messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: userPrompt }];
      const collected: string[] = [];
      let turns = 0;

      progress(`anthropic-api: starting (${model}${webEnabled ? `, web search ≤${webUses}` : ""})`);
      for (let attempt = 0; ; attempt++) {
        const body = JSON.stringify({
          model,
          max_tokens: 16384,
          // Streaming is a 524 fix, not a UX feature: without it the edge
          // caps COMPLETION time at ~100s no matter what timeoutMs says.
          stream: true,
          ...(disableThinking ? { thinking: { type: "disabled" } } : {}),
          system: SYSTEM_BLOCKS,
          ...(webEnabled
            ? { tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: webUses }] }
            : {}),
          messages,
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
          let json: MessageJson;
          try {
            json = await readMessage(res);
          } catch (err) {
            if (err instanceof DOMException && err.name === "TimeoutError") {
              throw new Error(`anthropic-api run timed out after ${timeoutMs}ms`);
            }
            // A cut or errored stream is transient the same way a 5xx is —
            // nothing was committed (messages state only advances on a fully
            // parsed response), so the whole request retries cleanly.
            const msg = err instanceof Error ? err.message : String(err);
            if (attempt < retryDelays.length) {
              const delay = retryDelays[attempt]!;
              progress(
                `anthropic-api: stream failed (${msg}) — retry ${attempt + 1}/${retryDelays.length} in ${delay}ms`,
              );
              await sleep(delay);
              continue;
            }
            throw new Error(`anthropic-api → stream failed after retries: ${msg}`);
          }
          const text = (json.content ?? [])
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("\n");
          // A paused turn is the API saying "the searches are still running" —
          // hand its own content back and let it finish. Text written before
          // the pause is kept; throwing it away is how a half-done sweep turns
          // into an empty report.
          if (json.stop_reason === "pause_turn" && turns < MAX_TURNS) {
            turns += 1;
            if (text) collected.push(text);
            messages = [...messages, { role: "assistant", content: json.content ?? [] }];
            attempt = -1; // HTTP retry budget is per request, not per turn
            progress(`anthropic-api: server tool paused the turn — continuing (${turns}/${MAX_TURNS})`);
            continue;
          }
          // Still paused with the turn budget spent: the sweep never
          // converged. Return everything written so far — a partial digest
          // beats a thrown-away one — but never as a clean run.
          if (json.stop_reason === "pause_turn") {
            const gathered = [...collected, text].filter(Boolean).join("\n").trim();
            progress(`anthropic-api: turn limit (${MAX_TURNS}) reached mid-search — returning partial output`);
            return {
              text: gathered,
              raw: json,
              tokens: json.usage,
              degraded: `web search did not converge within ${MAX_TURNS} turns — this report is partial`,
            };
          }
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
          return {
            text: [...collected, text].join("\n").trim(),
            raw: json,
            tokens: json.usage,
            ...(degraded ? { degraded } : {}),
          };
        }

        const raw = await res.text().catch(() => "");
        // The gateway refusing server tools must NOT take the whole beat down —
        // a digest missing its web sweep still carries the internal analysis.
        // But it must never read as a clean run: the retry carries an explicit
        // correction into the prompt, so the agent reports "could not check"
        // instead of "nothing changed", and `degraded` reaches the ledger.
        if (webEnabled && isToolRejection(res.status, raw)) {
          const reason = `the API rejected server-side web search (HTTP 400: ${raw.slice(0, 160)})`;
          webEnabled = false;
          degraded = reason;
          userPrompt = opts.prompt + CAPABILITY_CORRECTION(reason);
          messages = [{ role: "user", content: userPrompt }];
          collected.length = 0;
          attempt = -1;
          progress(`anthropic-api: web search unavailable — rerunning without it and telling the agent so`);
          continue;
        }
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
