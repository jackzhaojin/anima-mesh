import { getEnv } from "../instance/env-core.js";
import type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";
import type { ApiProviderContext } from "./moonshot-api.js";

/**
 * Claude via @anthropic-ai/claude-agent-sdk — the richer sibling of the
 * `claude-code` CLI provider. Auth is CLAUDE_CODE_OAUTH_TOKEN (subscription
 * billing via `claude setup-token`); no API key exists in this system.
 *
 * LAPTOP-TIER ONLY: the SDK spawns a bundled CLI subprocess, so this can
 * never run on Workers — it is deliberately absent from CLOUD_HARNESSES and
 * banned from the workers/ import graph. The SDK module itself is imported
 * lazily inside run() so loading the providers registry stays side-effect
 * free.
 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TURNS = 25;
// Read-only tools: the L1 contract — the harness, not the agent, writes artifacts.
const ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

export function createClaudeAgentSdkProvider(ctx: ApiProviderContext = {}): AgentWorkerProvider {
  const env = ctx.env ?? {};

  return {
    name: "claude-agent-sdk",

    assertConfigured(): void {
      if (!getEnv(env, "CLAUDE_CODE_OAUTH_TOKEN")) {
        throw new Error(
          "claude-agent-sdk: set CLAUDE_CODE_OAUTH_TOKEN (run 'claude setup-token'; see references/poc/claude/chat-cli)",
        );
      }
    },

    async run(opts: ProviderRunOptions): Promise<ProviderResult> {
      const token = getEnv(env, "CLAUDE_CODE_OAUTH_TOKEN");
      const progress = opts.onProgress ?? (() => {});
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      progress(`claude-agent-sdk: starting run${opts.model ? ` (${opts.model})` : ""}`);

      const stream = query({
        prompt: opts.prompt,
        options: {
          model: opts.model, // SDK resolves aliases ("sonnet", "opus") natively
          cwd: opts.cwd, // bundle root: relative reads keep working, same as claude-code
          maxTurns: MAX_TURNS,
          settingSources: [], // no user/project settings bleed into agent runs
          allowedTools: ALLOWED_TOOLS,
          // SDK option REPLACES the subprocess env (not merged) — spread
          // process.env ourselves and pin the resolved token on top.
          env: { ...(typeof process !== "undefined" ? process.env : {}), ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) },
        },
      });

      const consume = async (): Promise<ProviderResult> => {
        for await (const message of stream) {
          if (message.type === "result") {
            if (message.subtype === "success") {
              progress("claude-agent-sdk: done");
              return {
                text: message.result.trim(),
                raw: message,
                tokens: message.usage,
                costUsd: message.total_cost_usd,
              };
            }
            throw new Error(`claude-agent-sdk → result: ${message.subtype}`);
          }
        }
        throw new Error("claude-agent-sdk → stream ended without a result message");
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Best-effort stop; the subprocess dies with the interrupt or the run's end.
          void (stream as { interrupt?: () => Promise<void> }).interrupt?.()?.catch(() => {});
          reject(new Error(`claude-agent-sdk run timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      try {
        return await Promise.race([consume(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Default instance: env falls back to process.env (laptop CLI convenience). */
export const claudeAgentSdkProvider = createClaudeAgentSdkProvider();
