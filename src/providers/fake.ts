import type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";

/**
 * Deterministic provider for the regression suite. Tests hand it a handler;
 * it records every call. No network, no nondeterminism — the harness and
 * verifiers are exercised through exactly the seam real providers use.
 */
export type FakeHandler = (opts: ProviderRunOptions) => Promise<ProviderResult> | ProviderResult;

export class FakeProvider implements AgentWorkerProvider {
  readonly name = "fake";
  readonly calls: ProviderRunOptions[] = [];

  constructor(private readonly handler: FakeHandler = () => ({ text: "fake response" })) {}

  assertConfigured(): void {
    /* always configured */
  }

  async run(opts: ProviderRunOptions): Promise<ProviderResult> {
    this.calls.push(opts);
    return this.handler(opts);
  }
}
