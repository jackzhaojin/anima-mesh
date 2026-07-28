#!/usr/bin/env npx tsx
/**
 * Basic Kimi Code ACP client.
 * Hardcoded prompts: hello + haiku
 *
 * Successor to the original `kimi --wire` PoC. Kimi Code (0.27+) removed wire
 * mode; `kimi acp` speaks the Agent Client Protocol — still JSON-RPC 2.0 over
 * stdio, and still the mode that gives full observability plus the ability to
 * intercept approvals. The method names changed:
 *
 *   wire                      ACP
 *   ────────────────────────  ─────────────────────────────────────
 *   initialize                initialize            (camelCase params)
 *   (implicit session)        session/new  -> sessionId
 *   prompt {user_input}       session/prompt {sessionId, prompt: [...]}
 *   event/ContentPart         session/update -> agent_message_chunk
 *   request/ApprovalRequest   session/request_permission
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

/** Minimal JSON-RPC peer: sends requests, answers agent-initiated ones. */
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

    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const resolve = this.pending.get(msg.id as number);
      this.pending.delete(msg.id as number);
      if (resolve) resolve(msg);
      return;
    }

    // Streaming notification.
    if (msg.method === "session/update") {
      this.onUpdate(msg.params?.update ?? {});
      return;
    }

    // Agent-initiated request — must be answered or the turn stalls.
    if (msg.method === "session/request_permission") {
      const options: Array<Record<string, string>> = msg.params?.options ?? [];
      // Prefer the one-shot allow; fall back to whatever the agent offered.
      const choice =
        options.find((o) => o.kind === "allow_once") ??
        options.find((o) => o.kind === "allow_always") ??
        options[0];
      console.error(`[approval] ${msg.params?.toolCall?.title ?? "?"} -> ${choice?.optionId}`);
      this.write({
        jsonrpc: "2.0",
        id: msg.id,
        result: { outcome: { outcome: "selected", optionId: choice?.optionId } },
      });
      return;
    }

    // Any other agent request: answer with an error so the turn can proceed.
    if (msg.method !== undefined && msg.id !== undefined) {
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
}

async function main() {
  console.error("[*] Starting kimi acp ...");
  const proc = spawn("kimi", ["acp"], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });

  // Collect assistant text for the turn currently in flight.
  let collected: string[] = [];
  const client = new AcpClient(proc, rl, (update) => {
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      collected.push(update.content.text as string);
    }
  });

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

  const session = await client.request("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  });
  if (session.error) {
    console.error(`[!] session/new error: ${JSON.stringify(session.error)}`);
    process.exit(1);
  }
  const sessionId = session.result.sessionId as string;
  console.error(`[*] Session: ${sessionId}`);

  for (const promptText of ["hello", "write me a haiku"]) {
    console.log(`\n[User] ${promptText}`);
    collected = [];
    const res = await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    });
    if (res.error) console.error(`[error] ${JSON.stringify(res.error)}`);
    console.log(`[Kimi] ${collected.join("")}`);
  }

  proc.stdin!.end();
  proc.kill();
  console.error("\n[*] Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
