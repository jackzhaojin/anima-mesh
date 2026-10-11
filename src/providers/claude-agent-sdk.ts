import { getEnv } from "../instance/env-core.js";
import type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";
import type { ApiProviderContext } from "./moonshot-api.js";

/**
 * Claude via @anthropic-ai/claude-agent-sdk — the richer sibling of the
 * `claude-code` CLI provider. Two harnesses, one implementation, differing
 * only in billing:
 *
 * - `claude-agent-sdk`         — CLAUDE_CODE_OAUTH_TOKEN (subscription, via
 *   `claude setup-token`).
 * - `claude-agent-sdk-api-key` — ANTHROPIC_API_KEY (metered API credits);
 *   the path references/poc/claude/claude-api-poc proved live.
 *
 * Billing is chosen by the HARNESS, never by whichever credential happens
 * to be in the shell: the bundled CLI prefers ANTHROPIC_API_KEY over an
 * OAuth token, so a stray exported key would silently move a subscription
 * run onto credits. Each mode therefore strips the OTHER credential from
 * the subprocess env, and the api-key mode refuses a run whose SDK init
 * does not report ANTHROPIC_API_KEY as its source (the PoC's assertion).
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
// Granted only when the agent concept budgets web searches (`web:`), so an
// agent that never asked for the web cannot wander onto it.
const WEB_TOOL = "WebSearch";

/** Every variable that can authenticate the bundled CLI. */
const AUTH_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

interface SdkAuthMode {
  name: string;
  envVar: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY";
  setupHint: string;
  /** The SDK init message's apiKeySource this mode must see, when it is checkable. */
  expectSource?: string;
}

const OAUTH: SdkAuthMode = {
  name: "claude-agent-sdk",
  envVar: "CLAUDE_CODE_OAUTH_TOKEN",
  setupHint: "run 'claude setup-token'; see references/poc/claude/chat-cli",
};
const API_KEY: SdkAuthMode = {
  name: "claude-agent-sdk-api-key",
  envVar: "ANTHROPIC_API_KEY",
  setupHint: "a Console API key; see references/poc/claude/claude-api-poc",
  expectSource: "ANTHROPIC_API_KEY",
};

/** The subprocess env: the shell's, minus every auth var, plus this mode's one credential. */
export function sdkChildEnv(
  envVar: SdkAuthMode["envVar"],
  credential: string | undefined,
  base: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...base };
  for (const v of AUTH_VARS) delete out[v];
  if (credential) out[envVar] = credential;
  return out;
}

function createSdkProvider(mode: SdkAuthMode, ctx: ApiProviderContext): AgentWorkerProvider {
  const env = ctx.env ?? {};

  return {
    name: mode.name,
    // Tools are whitelisted by this provider itself (below), so unlike the
    // CLI harnesses both answers here are facts, not guesses.
    capabilities: { fileReads: true, webSearch: true },

    assertConfigured(): void {
      if (!getEnv(env, mode.envVar)) {
        throw new Error(`${mode.name}: set ${mode.envVar} (${mode.setupHint})`);
      }
    },

    async run(opts: ProviderRunOptions): Promise<ProviderResult> {
      const token = getEnv(env, mode.envVar);
      const progress = opts.onProgress ?? (() => {});
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      progress(`${mode.name}: starting run${opts.model ? ` (${opts.model})` : ""}`);

      const stream = query({
        prompt: opts.prompt,
        options: {
          model: opts.model, // SDK resolves aliases ("sonnet", "opus") natively
          cwd: opts.cwd, // bundle root: relative reads keep working, same as claude-code
          maxTurns: MAX_TURNS,
          settingSources: [], // no user/project settings bleed into agent runs
          allowedTools: (opts.webSearchMaxUses ?? 0) > 0 ? [...ALLOWED_TOOLS, WEB_TOOL] : ALLOWED_TOOLS,
          // SDK option REPLACES the subprocess env (not merged) — spread
          // process.env ourselves, minus every competing credential, and pin
          // this mode's one credential on top.
          env: sdkChildEnv(mode.envVar, token),
        },
      });

      const consume = async (): Promise<ProviderResult> => {
        for await (const message of stream) {
          if (mode.expectSource && message.type === "system" && message.subtype === "init") {
            const source = (message as { apiKeySource?: string }).apiKeySource;
            if (source !== mode.expectSource) {
              void (stream as { interrupt?: () => Promise<void> }).interrupt?.()?.catch(() => {});
              throw new Error(
                `${mode.name} → the SDK authenticated with '${source ?? "unknown"}', not ${mode.expectSource} — refusing a run billed somewhere other than the harness says`,
              );
            }
          }
          if (message.type === "result") {
            if (message.subtype === "success") {
              progress(`${mode.name}: done`);
              return {
                text: message.result.trim(),
                raw: message,
                tokens: message.usage,
                costUsd: message.total_cost_usd,
              };
            }
            throw new Error(`${mode.name} → result: ${message.subtype}`);
          }
        }
        throw new Error(`${mode.name} → stream ended without a result message`);
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Best-effort stop; the subprocess dies with the interrupt or the run's end.
          void (stream as { interrupt?: () => Promise<void> }).interrupt?.()?.catch(() => {});
          reject(new Error(`${mode.name} run timed out after ${timeoutMs}ms`));
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

export function createClaudeAgentSdkProvider(ctx: ApiProviderContext = {}): AgentWorkerProvider {
  return createSdkProvider(OAUTH, ctx);
}

export function createClaudeAgentSdkApiKeyProvider(ctx: ApiProviderContext = {}): AgentWorkerProvider {
  return createSdkProvider(API_KEY, ctx);
}

/** Default instances: env falls back to process.env (laptop CLI convenience). */
export const claudeAgentSdkProvider = createClaudeAgentSdkProvider();
export const claudeAgentSdkApiKeyProvider = createClaudeAgentSdkApiKeyProvider();
