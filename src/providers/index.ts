import type { AgentWorkerProvider } from "./types.js";
import { FakeProvider } from "./fake.js";
import {
  createMoonshotApiProvider,
  moonshotApiProvider,
  type ApiProviderContext,
} from "./moonshot-api.js";

export type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";
export { FakeProvider } from "./fake.js";
export {
  createMoonshotApiProvider,
  moonshotApiProvider,
  type ApiProviderContext,
} from "./moonshot-api.js";

/**
 * The provider registry core — Workers-safe: only fetch-based providers are
 * imported here. Subprocess providers (claude-code, opencode,
 * claude-agent-sdk) live in node-providers.ts, which Node entrypoints
 * import for its registration side effect; nothing under workers/ may.
 */
const registry = new Map<string, AgentWorkerProvider>([
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
]);

/**
 * The harnesses a cloud beat may run. Everything else is subprocess-bound —
 * laptop-tier by architecture, skipped with reason by the cloud heartbeat.
 * Deliberately NOT including `claude-agent-sdk`: the SDK spawns a bundled
 * CLI, which no Worker hosts.
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

export function registerContextualFactory(
  name: string,
  factory: (ctx: ApiProviderContext) => AgentWorkerProvider,
): void {
  contextualFactories.set(name, factory);
}
