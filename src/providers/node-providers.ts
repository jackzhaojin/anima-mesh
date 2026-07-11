import { registerProvider, registerContextualFactory } from "./index.js";
import { claudeCodeProvider } from "./claude-code.js";
import { opencodeProvider } from "./opencode.js";
import { createClaudeAgentSdkProvider, claudeAgentSdkProvider } from "./claude-agent-sdk.js";

/**
 * Subprocess-bound providers — Node-only, registered as a side effect of
 * importing this module. Every Node entrypoint (cli.ts, src/index.ts,
 * harness/run.ts) imports it; workers/ code MUST NOT (the import-hygiene
 * test enforces this).
 */
registerProvider(claudeCodeProvider);
registerProvider(opencodeProvider);
registerProvider(claudeAgentSdkProvider);
registerContextualFactory("claude-agent-sdk", createClaudeAgentSdkProvider);

export { claudeCodeProvider } from "./claude-code.js";
export { opencodeProvider } from "./opencode.js";
export { claudeAgentSdkProvider, createClaudeAgentSdkProvider } from "./claude-agent-sdk.js";
