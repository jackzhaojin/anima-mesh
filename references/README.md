# references/ — proof-of-concept lineage

Read-only examples that informed the engine's design. **Not engine code**:
excluded from tsconfig, never imported by `src/`, kept as evidence and
onboarding material for the provider chokepoint.

## poc/kimi — Kimi CLI integration modes

The study behind the `opencode` provider's design values:

- `acp/` — bidirectional JSON-RPC over stdio (`kimi acp`): full
  observability, event-by-event streaming, approval interception.
- `print/` — headless (`kimi -p --output-format stream-json`): the
  agent-worker pattern; structured JSONL out, no interactivity.

Key learning: print mode suits fire-and-forget workers; the stdio protocol
suits custom UIs. The engine ultimately drives Kimi via `opencode serve`
(REST + SSE) instead — same observability with a stable HTTP surface.

Originally written against legacy `kimi-cli`, whose `--wire` mode Kimi Code
replaced with the Agent Client Protocol; `acp/` is the ported form. See
[poc/kimi/README.md](poc/kimi/README.md) for the full flag mapping.

## poc/claude — Claude Agent SDK studies

- `chat-cli/` — minimal SDK chat loop.
- `agent-sdk-subagents-poc/` — spawning subagents; findings in FINDINGS.md.
- `agent-sdk-skills-poc/` — skill invocation mechanics; findings in FINDINGS.md.

## poc/codex — Codex CLI studies

- `hello-world/`, `streaming-tools-poc/` — streaming + tool-call handling.

## Hygiene

These were imported from a private research repo after a secrets scan and
with instance-specific material removed. Anything added here must pass the
same bar: no credentials, no real run data, no references to any particular
organization or persona.
