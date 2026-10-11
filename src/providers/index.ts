import type { AgentWorkerProvider } from "./types.js";
import { FakeProvider } from "./fake.js";
import {
  createMoonshotApiProvider,
  moonshotApiProvider,
  type ApiProviderContext,
} from "./moonshot-api.js";
import {
  createAnthropicApiProvider,
  anthropicApiProvider,
  createAnthropicApiKeyProvider,
  anthropicApiKeyProvider,
} from "./anthropic-api.js";
import { createOpenAICodexProvider, openaiCodexProvider } from "./openai-codex.js";

export type {
  AgentWorkerProvider,
  ProviderRunOptions,
  ProviderResult,
  ProviderCapabilities,
} from "./types.js";
export { providerCapabilities, NO_CAPABILITIES } from "./types.js";
export { FakeProvider } from "./fake.js";
export {
  createMoonshotApiProvider,
  moonshotApiProvider,
  type ApiProviderContext,
} from "./moonshot-api.js";
export {
  createAnthropicApiProvider,
  anthropicApiProvider,
  createAnthropicApiKeyProvider,
  anthropicApiKeyProvider,
} from "./anthropic-api.js";
export { createOpenAICodexProvider, openaiCodexProvider } from "./openai-codex.js";
export {
  codexAuthSource,
  staticCodexAuth,
  memoryTokenStore,
  type CodexAuth,
  type CodexAuthSource,
  type CodexTokens,
  type CodexTokenStore,
} from "./codex-auth.js";

/**
 * The provider registry core — Workers-safe: only fetch-based providers are
 * imported here. Subprocess providers (claude-code, opencode, codex,
 * claude-agent-sdk[-api-key]) live in node-providers.ts, which Node entrypoints
 * import for its registration side effect; nothing under workers/ may.
 */
const registry = new Map<string, AgentWorkerProvider>([
  ["moonshot-api", moonshotApiProvider],
  ["anthropic-api", anthropicApiProvider],
  ["anthropic-api-key", anthropicApiKeyProvider],
  ["openai-codex", openaiCodexProvider],
  ["fake", new FakeProvider()],
]);

/**
 * API providers accept an injected env/fetch context (Worker secrets, or the
 * instance's .env on the laptop). Subprocess providers register their own
 * factories from node-providers.ts; they take only their auth keys from the
 * context (providers/subprocess-env.ts).
 */
const contextualFactories = new Map<string, (ctx: ApiProviderContext) => AgentWorkerProvider>([
  ["moonshot-api", createMoonshotApiProvider],
  ["anthropic-api", createAnthropicApiProvider],
  ["anthropic-api-key", createAnthropicApiKeyProvider],
  ["openai-codex", createOpenAICodexProvider],
]);

/**
 * The harnesses a cloud beat may run. Everything else is subprocess-bound —
 * laptop-tier by architecture, skipped with reason by the cloud heartbeat.
 * Deliberately NOT including `claude-agent-sdk[-api-key]` or `codex`: both
 * spawn a CLI, which no Worker hosts.
 *
 * Billing is part of the harness name, so the brain picks it per agent:
 * `anthropic-api` = Claude subscription, `anthropic-api-key` = metered API
 * credits, `openai-codex` = ChatGPT-plan Codex quota, `moonshot-api` = Kimi.
 */
export const CLOUD_HARNESSES: ReadonlySet<string> = new Set([
  "moonshot-api",
  "anthropic-api",
  "anthropic-api-key",
  "openai-codex",
]);

/**
 * Resolve a harness name (from an agent concept's `harness:` field) to a
 * provider. Tests and instances may register their own — the registry is
 * the chokepoint, not a closed set. When `ctx` is given and the harness has
 * a contextual factory, the provider is bound to that env/fetch context.
 */
export function resolveProvider(harness: string, ctx?: ApiProviderContext): AgentWorkerProvider {
  if (ctx) {
    const factory = contextualFactories.get(harness);
    if (factory) return factory(ctx);
  }
  const provider = registry.get(harness);
  if (!provider) {
    throw new Error(`unknown harness '${harness}' — registered: ${[...registry.keys()].join(", ")}`);
  }
  return provider;
}

export function registerProvider(provider: AgentWorkerProvider, name = provider.name): void {
  registry.set(name, provider);
}

export function registerContextualFactory(
  name: string,
  factory: (ctx: ApiProviderContext) => AgentWorkerProvider,
): void {
  contextualFactories.set(name, factory);
}
