import { registerProvider, registerContextualFactory } from "./index.js";
import { claudeCodeProvider } from "./claude-code.js";
import { opencodeProvider } from "./opencode.js";
import { codexProvider } from "./codex.js";
import { createOpenAICodexProvider } from "./openai-codex.js";
import { fileCodexAuth } from "./codex-auth-file.js";
import {
  createClaudeAgentSdkProvider,
  claudeAgentSdkProvider,
  createClaudeAgentSdkApiKeyProvider,
  claudeAgentSdkApiKeyProvider,
} from "./claude-agent-sdk.js";

/**
 * Subprocess-bound providers — Node-only, registered as a side effect of
 * importing this module. Every Node entrypoint (cli.ts, src/index.ts,
 * harness/run.ts) imports it; workers/ code MUST NOT (the import-hygiene
 * test enforces this).
 */
registerProvider(claudeCodeProvider);
registerProvider(opencodeProvider);
registerProvider(codexProvider);
registerProvider(claudeAgentSdkProvider);
registerProvider(claudeAgentSdkApiKeyProvider);
registerContextualFactory("claude-agent-sdk", createClaudeAgentSdkProvider);
registerContextualFactory("claude-agent-sdk-api-key", createClaudeAgentSdkApiKeyProvider);

// `openai-codex` on the laptop refreshes through the Codex CLI's own auth.json
// (rotating refresh tokens need a persisting owner — codex-auth.ts). The
// Workers-safe registration in index.ts stays static-token-only.
registerProvider(createOpenAICodexProvider({ codexAuth: fileCodexAuth() }));
registerContextualFactory("openai-codex", (ctx) =>
  createOpenAICodexProvider({ ...ctx, codexAuth: ctx.codexAuth ?? fileCodexAuth(ctx.env) }),
);

export { claudeCodeProvider } from "./claude-code.js";
export { opencodeProvider } from "./opencode.js";
export { codexProvider, codexExecArgs, parseCodexEvents } from "./codex.js";
export { fileCodexAuth, authJsonTokenStore, codexAuthJsonPath } from "./codex-auth-file.js";
export {
  claudeAgentSdkProvider,
  createClaudeAgentSdkProvider,
  claudeAgentSdkApiKeyProvider,
  createClaudeAgentSdkApiKeyProvider,
} from "./claude-agent-sdk.js";
