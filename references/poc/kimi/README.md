# Kimi Code CLI Integration PoCs

This folder contains proof-of-concept integrations for [Kimi Code CLI](https://moonshotai.github.io/kimi-code/) demonstrating both **ACP mode** (bidirectional JSON-RPC over stdio) and **Print mode** (headless, non-interactive).

> **Migration note (verified 2026-07-27 against Kimi Code 0.27.0).** These PoCs
> were originally written against the legacy `kimi-cli`, which Kimi Code
> replaces. Three flags used by the originals no longer exist:
>
> | legacy `kimi-cli` | Kimi Code 0.27+ |
> |---|---|
> | `--quiet` | removed — `-p` is the non-interactive entry point |
> | `--print -p X --output-format=stream-json` | `-p X --output-format stream-json` |
> | `--wire` | removed — replaced by `kimi acp` (Agent Client Protocol) |
>
> The `wire/` folder is now `acp/` and its two clients were rewritten against
> ACP. Print-mode JSONL kept its message shape (`role`/`content`/`tool_calls`/
> `tool_call_id`) but now ends with a `role: "meta"` session-resume line.

## What we built

### ACP mode (`acp/`)

`kimi acp` runs Kimi Code as an [Agent Client Protocol](https://agentclientprotocol.com)
server over stdin/stdout. This is the mode used by custom UIs, IDE plugins, and
any tool that needs full observability and control.

- **`basic-acp.ts`** — Minimal hardcoded client. Sends `initialize`, opens a
  session with `session/new`, runs two prompts (`hello` and `write me a haiku`)
  via `session/prompt`, collects the streamed text, and exits.
- **`stream-acp.ts`** — Advanced interactive REPL. Renders every `session/update`
  in real time (`agent_thought_chunk`, `agent_message_chunk`, `tool_call`,
  `tool_call_update`, `plan`), auto-approves `session/request_permission`, and
  supports `/cancel` and `/quit`.

### Print mode (`print/`)

Print mode runs Kimi Code headlessly — perfect for scripts, CI/CD, and agent workers.

- **`basic-print.ts`** — Simplest possible usage. Runs `kimi -p "..."` and prints the response.
- **`agent-worker.ts`** — Uses `-p --output-format stream-json` to capture the full structured message stream (assistant thinking, tool calls, tool results) in real-time.
- **`agent-stream-json-log.ts`** — Runs a complex multi-tool prompt, pretty-prints each JSONL line to the console, and writes the raw stream to a timestamped file in `output/` for later inspection.

## How to run

All PoCs are written in TypeScript and executed with `tsx`. **There is no local `node_modules` or `package.json` inside this folder.** They use only Node.js built-ins (`child_process`, `fs`, `path`, `readline`) plus `tsx`, which the repo root already provides.

Run any script from the **repo root**:

```bash
npx tsx references/poc/kimi/acp/basic-acp.ts
npx tsx references/poc/kimi/acp/stream-acp.ts
npx tsx references/poc/kimi/print/basic-print.ts
npx tsx references/poc/kimi/print/agent-worker.ts
npx tsx references/poc/kimi/print/agent-stream-json-log.ts
```

The print PoCs derive their working directory from the script's own location,
so they behave the same regardless of where you invoke them from.

## Key learnings

| Mode | Best for | Real-time tool visibility | Interactive control |
|------|----------|---------------------------|---------------------|
| `-p` (text) | Fire-and-forget tasks | ❌ | ❌ |
| `-p --output-format stream-json` | Agent workers, pipelines | ✅ (message-by-message) | ❌ (auto-approved) |
| `kimi acp` | Custom UIs, full observability | ✅ (event-by-event, token-by-token) | ✅ |

- Print mode's `stream-json` gives you tool calls and tool results as they happen — but only whole messages, with no step boundaries or live token metrics.
- ACP mode gives you token-by-token `agent_thought_chunk` and `agent_message_chunk` streams, per-tool `tool_call`/`tool_call_update` transitions, and the ability to intercept approvals via `session/request_permission`.
- ACP carries **no token-usage metrics** — the legacy wire `StatusUpdate` event has no equivalent. The `/usage` session command is the replacement.

## Output logs

The `print/output/` directory is `.gitignore`d. `agent-stream-json-log.ts` writes raw JSONL streams there so you can inspect the full verbosity of Kimi's print-mode output offline.
