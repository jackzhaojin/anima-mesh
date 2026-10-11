import { registerProvider, registerContextualFactory } from "./index.js";
import { claudeCodeProvider, createClaudeCodeProvider } from "./claude-code.js";
import { opencodeProvider, createOpencodeProvider } from "./opencode.js";
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
registerContextualFactory("claude-code", createClaudeCodeProvider);
registerContextualFactory("opencode", createOpencodeProvider);
registerContextualFactory("claude-agent-sdk", createClaudeAgentSdkProvider);
registerContextualFactory("claude-agent-sdk-api-key", createClaudeAgentSdkApiKeyProvider);

// `openai-codex` on the laptop BORROWS the Codex login in auth.json read-only
// and never refreshes it (codex-auth-file.ts: refreshing a shared login broke
// the desktop app's copy, live 2026-10-11)
// (rotating refresh tokens need a persisting owner — codex-auth.ts). The
// Workers-safe registration in index.ts stays static-token-only.
registerProvider(createOpenAICodexProvider({ codexAuth: fileCodexAuth() }));
registerContextualFactory("openai-codex", (ctx) =>
  createOpenAICodexProvider({ ...ctx, codexAuth: ctx.codexAuth ?? fileCodexAuth(ctx.env) }),
);

export { claudeCodeProvider, createClaudeCodeProvider } from "./claude-code.js";
export { opencodeProvider, createOpencodeProvider } from "./opencode.js";
export { codexProvider, codexExecArgs, parseCodexEvents } from "./codex.js";
export { fileCodexAuth, codexAuthJsonPath } from "./codex-auth-file.js";
export {
  claudeAgentSdkProvider,
  createClaudeAgentSdkProvider,
  claudeAgentSdkApiKeyProvider,
  createClaudeAgentSdkApiKeyProvider,
} from "./claude-agent-sdk.js";
