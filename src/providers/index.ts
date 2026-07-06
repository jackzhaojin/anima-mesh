import type { AgentWorkerProvider } from "./types.js";
import { FakeProvider } from "./fake.js";
import { claudeCodeProvider } from "./claude-code.js";
import { opencodeProvider } from "./opencode.js";

export type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";
export { FakeProvider } from "./fake.js";
export { claudeCodeProvider } from "./claude-code.js";
export { opencodeProvider } from "./opencode.js";

const registry = new Map<string, AgentWorkerProvider>([
  ["claude-code", claudeCodeProvider],
  ["opencode", opencodeProvider],
  ["fake", new FakeProvider()],
]);

/**
 * Resolve a harness name (from an agent concept's `harness:` field) to a
 * provider. Tests and instances may register their own — the registry is
 * the chokepoint, not a closed set.
 */
export function resolveProvider(harness: string): AgentWorkerProvider {
  const provider = registry.get(harness);
  if (!provider) {
    throw new Error(`unknown harness '${harness}' — registered: ${[...registry.keys()].join(", ")}`);
  }
  return provider;
}

export function registerProvider(provider: AgentWorkerProvider, name = provider.name): void {
  registry.set(name, provider);
}
