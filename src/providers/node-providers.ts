import { registerProvider, registerContextualFactory } from "./index.js";
import { claudeCodeProvider, createClaudeCodeProvider } from "./claude-code.js";
import { opencodeProvider, createOpencodeProvider } from "./opencode.js";
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
registerContextualFactory("claude-code", createClaudeCodeProvider);
registerContextualFactory("opencode", createOpencodeProvider);
registerContextualFactory("claude-agent-sdk", createClaudeAgentSdkProvider);

export { claudeCodeProvider, createClaudeCodeProvider } from "./claude-code.js";
export { opencodeProvider, createOpencodeProvider } from "./opencode.js";
export { claudeAgentSdkProvider, createClaudeAgentSdkProvider } from "./claude-agent-sdk.js";
