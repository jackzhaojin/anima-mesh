import type { AgentWorkerProvider } from "./types.js";
import { FakeProvider } from "./fake.js";
import { claudeCodeProvider } from "./claude-code.js";
import { opencodeProvider } from "./opencode.js";
import {
  createMoonshotApiProvider,
  moonshotApiProvider,
  type ApiProviderContext,
} from "./moonshot-api.js";
import { createClaudeAgentSdkProvider, claudeAgentSdkProvider } from "./claude-agent-sdk.js";

export type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";
export { FakeProvider } from "./fake.js";
export { claudeCodeProvider } from "./claude-code.js";
export { opencodeProvider } from "./opencode.js";
export {
  createMoonshotApiProvider,
  moonshotApiProvider,
  type ApiProviderContext,
} from "./moonshot-api.js";
export { createClaudeAgentSdkProvider, claudeAgentSdkProvider } from "./claude-agent-sdk.js";

const registry = new Map<string, AgentWorkerProvider>([
  ["claude-code", claudeCodeProvider],
  ["opencode", opencodeProvider],
  ["claude-agent-sdk", claudeAgentSdkProvider],
  ["moonshot-api", moonshotApiProvider],
  ["fake", new FakeProvider()],
]);

/**
 * API providers accept an injected env/fetch context (Worker secrets, or the
 * instance's .env on the laptop). CLI providers read process.env in their
 * subprocess and take no context.
 */
const contextualFactories = new Map<string, (ctx: ApiProviderContext) => AgentWorkerProvider>([
  ["moonshot-api", createMoonshotApiProvider],
  ["claude-agent-sdk", createClaudeAgentSdkProvider],
]);

/**
 * The harnesses a cloud beat may run (doc: cloudflare-buildout). Everything
 * else is subprocess-bound — laptop-tier by architecture, skipped with
 * reason by the cloud heartbeat. Deliberately NOT including
 * `claude-agent-sdk`: the SDK spawns a bundled CLI, which no Worker hosts.
 */
export const CLOUD_HARNESSES: ReadonlySet<string> = new Set(["moonshot-api"]);

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
