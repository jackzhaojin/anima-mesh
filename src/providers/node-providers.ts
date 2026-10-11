import { registerProvider, registerContextualFactory } from "./index.js";
import { claudeCodeProvider } from "./claude-code.js";
import { opencodeProvider } from "./opencode.js";
import { codexProvider } from "./codex.js";
import { createCodexApiProvider } from "./codex-api.js";
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

// `codex-api` on the laptop refreshes through the Codex CLI's own auth.json
// (rotating refresh tokens need a persisting owner — codex-auth.ts). The
// Workers-safe registration in index.ts stays static-token-only.
registerProvider(createCodexApiProvider({ codexAuth: fileCodexAuth() }));
registerContextualFactory("codex-api", (ctx) =>
  createCodexApiProvider({ ...ctx, codexAuth: ctx.codexAuth ?? fileCodexAuth(ctx.env) }),
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
