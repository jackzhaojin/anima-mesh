# Kimi Code CLI Integration PoCs

This folder contains proof-of-concept integrations for [Kimi Code CLI](https://github.com/MoonshotAI/kimi-cli) demonstrating both **Wire mode** (bidirectional JSON-RPC) and **Print mode** (headless, non-interactive).

## What we built

### Wire mode (`wire/`)

Wire mode exposes Kimi CLI's internal JSON-RPC 2.0 protocol over stdin/stdout. This is the mode used by custom UIs, IDE plugins, and any tool that needs full observability and control.

- **`basic-wire.ts`** — Minimal hardcoded client. Sends `initialize`, then two prompts (`hello` and `write me a haiku`), collects text responses, and exits.
- **`stream-wire.ts`** — Advanced interactive REPL. Streams every event in real-time (`TurnBegin`, `StepBegin`, `ContentPart`, `ToolCall`, `StatusUpdate`, etc.), handles approvals/questions/tool requests automatically, and supports `/cancel` and `/quit` commands.

### Print mode (`print/`)

Print mode runs Kimi CLI headlessly — perfect for scripts, CI/CD, and agent workers.

- **`basic-print.ts`** — Simplest possible usage. Runs `kimi --quiet -p "..."` and prints the final text response.
- **`agent-worker.ts`** — Uses `--print --output-format=stream-json` to capture the full structured message stream (assistant thinking, tool calls, tool results) in real-time.
- **`agent-stream-json-log.ts`** — Runs a complex multi-tool prompt, pretty-prints each JSONL line to the console, and writes the raw stream to a timestamped file in `output/` for later inspection.

## How to run

All PoCs are written in TypeScript and executed with `tsx`. **There is no local `node_modules` or `package.json` inside this folder.** Instead, we rely on the parent project (`continuous-agent-develop`) which already has `tsx` and TypeScript installed in its root `node_modules`.

Run any script from the **project root**:

```bash
# From /Users/jackjin/dev/continuous-agent-develop
npx tsx references/poc/kimi/wire/basic-wire.ts
npx tsx references/poc/kimi/wire/stream-wire.ts
npx tsx references/poc/kimi/print/basic-print.ts
npx tsx references/poc/kimi/print/agent-worker.ts
npx tsx references/poc/kimi/print/agent-stream-json-log.ts
```

### Why no local `node_modules`?

The scripts only use **Node.js built-in modules** (`child_process`, `crypto`, `fs`, `path`, `readline`) plus `tsx` for execution. Since `tsx` is already available in the root project's `node_modules`, these PoCs are completely self-contained and require no additional installation inside this subfolder.

## Key learnings

| Mode | Best for | Real-time tool visibility | Interactive control |
|------|----------|---------------------------|---------------------|
| `--quiet` | Fire-and-forget tasks | ❌ | ❌ |
| `--print --output-format=stream-json` | Agent workers, pipelines | ✅ (message-by-message) | ❌ (auto-approved) |
| `--wire` | Custom UIs, full observability | ✅ (event-by-event, token-by-token) | ✅ |

- Print mode's `stream-json` gives you thinking blocks, tool calls, and tool results as they happen — but lacks step boundaries and live token metrics.
- Wire mode gives you everything: `TurnBegin`, `StepBegin`, `think` events, `StatusUpdate` with token usage, and the ability to intercept approvals or steer mid-turn.

## Output logs

The `print/output/` directory is `.gitignore`d. `agent-stream-json-log.ts` writes raw JSONL streams there so you can inspect the full verbosity of Kimi's print-mode output offline.
