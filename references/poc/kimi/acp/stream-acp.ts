#!/usr/bin/env npx tsx
/**
 * Advanced Kimi Code ACP client.
 * Features: interactive REPL, real-time streaming, rich event logging,
 * /cancel and /quit commands, full approval + fs-request handling.
 *
 * Successor to the original `kimi --wire` PoC — Kimi Code (0.27+) removed wire
 * mode in favour of the Agent Client Protocol (`kimi acp`). Event mapping:
 *
 *   wire event            ACP session/update
 *   ────────────────────  ────────────────────────────────────────────
 *   TurnBegin/TurnEnd     (implicit: session/prompt request + response)
 *   ContentPart text      agent_message_chunk
 *   ContentPart think     agent_thought_chunk
 *   ToolCall              tool_call
 *   ToolResult            tool_call_update  (status=completed/failed)
 *   PlanDisplay           plan
 *   StatusUpdate          (no equivalent — ACP carries no token metrics)
 *   ApprovalRequest       session/request_permission  (agent -> client)
 *   cancel                session/cancel              (notification)
 */

import { spawn, ChildProcess } from "child_process";
import * as readline from "readline";

interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

function logEvent(type: string, detail: string): void {
  console.error(`\x1b[2m[acp:${type}] ${detail}\x1b[0m`);
}

function truncate(s: string, n = 160): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/** JSON-RPC peer over the agent's stdio: requests out, notifications + agent requests in. */
class AcpClient {
  private nextId = 0;
  private pending = new Map<number, (msg: JSONRPCMessage) => void>();
  private closed = false;

  constructor(
    private proc: ChildProcess,
    rl: readline.Interface,
    private onUpdate: (update: Record<string, any>) => void
  ) {
    rl.on("line", (line) => this.handleLine(line));
    rl.on("close", () => {
      this.closed = true;
      for (const resolve of this.pending.values()) {
        resolve({ jsonrpc: "2.0", error: { code: -1, message: "stream closed" } });
      }
      this.pending.clear();
    });
  }

  private write(msg: JSONRPCMessage): void {
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: JSONRPCMessage;
    try {
      msg = JSON.parse(line) as JSONRPCMessage;
    } catch {
      console.error(`[!] Bad JSON: ${line}`);
      return;
    }

    if (msg.id !== undefined && msg.method === undefined) {
      const resolve = this.pending.get(msg.id as number);
      this.pending.delete(msg.id as number);
      if (resolve) resolve(msg);
      return;
    }

    if (msg.method === "session/update") {
      this.onUpdate(msg.params?.update ?? {});
      return;
    }

    // ── Agent-initiated requests. Every one must be answered or the turn hangs.
    if (msg.method === "session/request_permission") {
      const options: Array<Record<string, string>> = msg.params?.options ?? [];
      const choice =
        options.find((o) => o.kind === "allow_once") ??
        options.find((o) => o.kind === "allow_always") ??
        options[0];
      logEvent("approval", `${msg.params?.toolCall?.title ?? "?"} -> ${choice?.optionId}`);
      this.write({
        jsonrpc: "2.0",
        id: msg.id,
        result: { outcome: { outcome: "selected", optionId: choice?.optionId } },
      });
      return;
    }

    if (msg.method !== undefined && msg.id !== undefined) {
      logEvent("unhandled-req", `${msg.method}`);
      this.write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `${msg.method} not implemented in PoC` },
      });
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<JSONRPCMessage> {
    if (this.closed) {
      return Promise.resolve({ jsonrpc: "2.0", error: { code: -1, message: "closed" } });
    }
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Fire-and-forget notification (no id, no response expected). */
  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }
}

/** Render one session/update to the console, mirroring the old wire event log. */
function renderUpdate(update: Record<string, any>): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content?.type === "text") process.stdout.write(update.content.text);
      break;
    case "agent_thought_chunk":
      // Thought chunks arrive token-by-token; keep them dim and inline.
      if (update.content?.type === "text" && update.content.text) {
        process.stderr.write(`\x1b[2m${update.content.text}\x1b[0m`);
      }
      break;
    case "tool_call":
      logEvent("tool", `call ${update.title ?? "?"} kind=${update.kind ?? "?"} status=${update.status ?? "?"}`);
      break;
    case "tool_call_update":
      // Only log terminal states — in_progress fires once per streamed arg token.
      if (update.status === "completed" || update.status === "failed") {
        const out = typeof update.rawOutput === "string" ? truncate(update.rawOutput) : "";
        logEvent("tool", `result status=${update.status}${out ? ` output=${JSON.stringify(out)}` : ""}`);
      }
      break;
    case "plan":
      logEvent("plan", `${(update.entries ?? []).length} entries`);
      break;
    case "available_commands_update":
      logEvent("commands", `${(update.availableCommands ?? []).length} available`);
      break;
    case "user_message_chunk":
      break;
    default:
      logEvent("event", `${update.sessionUpdate}`);
  }
}

async function main() {
  console.error("[*] Starting kimi acp (advanced stream-cli)");
  console.error("[*] Type a message and press Enter. Commands: /cancel, /quit\n");

  const proc = spawn("kimi", ["acp"], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  const client = new AcpClient(proc, rl, renderUpdate);

  const init = await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  if (init.error) {
    console.error(`[!] Initialize error: ${JSON.stringify(init.error)}`);
    process.exit(1);
  }
  const info = init.result?.agentInfo ?? {};
  console.error(`[*] Initialized: ${info.name ?? "?"} ${info.version ?? ""}`);

  const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  if (session.error) {
    console.error(`[!] session/new error: ${JSON.stringify(session.error)}`);
    process.exit(1);
  }
  const sessionId = session.result.sessionId as string;
  console.error(`[*] Session: ${sessionId}`);

  const stdinRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[1mYou>\x1b[0m ",
  });
  stdinRl.prompt();

  for await (const line of stdinRl) {
    const input = line.trim();
    if (!input) {
      stdinRl.prompt();
      continue;
    }
    if (input === "/quit") {
      console.error("[*] Quitting...");
      break;
    }
    if (input === "/cancel") {
      // ACP cancel is a notification, not a request — no response comes back.
      client.notify("session/cancel", { sessionId });
      logEvent("cancel", "sent");
      stdinRl.prompt();
      continue;
    }

    process.stdout.write("\x1b[1mKimi>\x1b[0m ");
    const res = await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: input }],
    });
    if (res.error) logEvent("prompt", `error ${JSON.stringify(res.error)}`);
    else logEvent("prompt", `finished stopReason=${res.result?.stopReason}`);
    process.stdout.write("\n");
    stdinRl.prompt();
  }

  stdinRl.close();
  proc.stdin!.end();
  proc.kill();
  console.error("[*] Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
