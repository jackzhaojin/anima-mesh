#!/usr/bin/env npx tsx
/**
 * Basic Kimi Code CLI Wire mode chat client.
 * Hardcoded prompts: hello + haiku
 */

import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as readline from "readline";

interface JSONRPCRequest {
  jsonrpc: "2.0";
  method: string;
  id: string;
  params: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type WireMessage = JSONRPCRequest | JSONRPCResponse;

function makeRequest(method: string, params: Record<string, unknown>): JSONRPCRequest {
  return { jsonrpc: "2.0", method, id: randomUUID(), params };
}

function send(proc: ChildProcess, msg: WireMessage): void {
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}

class WireReader {
  private queue: WireMessage[] = [];
  private resolvers: Array<(msg: WireMessage | null) => void> = [];
  private closed = false;

  constructor(rl: readline.Interface) {
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as WireMessage;
        const resolver = this.resolvers.shift();
        if (resolver) resolver(msg);
        else this.queue.push(msg);
      } catch {
        console.error(`[!] Bad JSON: ${line}`);
      }
    });
    rl.on("close", () => {
      this.closed = true;
      while (this.resolvers.length > 0) this.resolvers.shift()!(null);
    });
  }

  async recv(): Promise<WireMessage | null> {
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.closed) return null;
    return new Promise<WireMessage | null>((resolve) => this.resolvers.push(resolve));
  }
}

async function runPrompt(
  proc: ChildProcess,
  reader: WireReader,
  text: string
): Promise<string> {
  const req = makeRequest("prompt", { user_input: text });
  send(proc, req);
  const reqId = req.id;
  const collectedText: string[] = [];

  while (true) {
    const msg = await reader.recv();
    if (!msg) continue;

    if ("method" in msg && !("id" in msg)) {
      if (msg.method === "event") {
        const params = msg.params || {};
        const evtType = params.type as string;
        const payload = (params.payload as Record<string, unknown>) || {};
        if (evtType === "ContentPart" && payload.type === "text") {
          collectedText.push(payload.text as string);
        } else if (evtType === "TurnEnd") {
          // keep waiting for JSON-RPC response
        }
      } else if (msg.method === "request") {
        const params = msg.params || {};
        const reqType = params.type as string;
        const payload = (params.payload as Record<string, unknown>) || {};
        const respId = (msg as JSONRPCRequest).id;

        if (reqType === "ApprovalRequest") {
          send(proc, {
            jsonrpc: "2.0",
            id: respId,
            result: { request_id: payload.id, response: "approve" },
          } as JSONRPCResponse);
        } else if (reqType === "ToolCallRequest") {
          send(proc, {
            jsonrpc: "2.0",
            id: respId,
            result: {
              tool_call_id: payload.id,
              return_value: {
                is_error: true,
                output: "External tool not implemented in PoC",
                message: "External tool not implemented in PoC",
                display: [],
              },
            },
          } as JSONRPCResponse);
        } else if (reqType === "QuestionRequest") {
          send(proc, {
            jsonrpc: "2.0",
            id: respId,
            result: { request_id: payload.id, answers: {} },
          } as JSONRPCResponse);
        }
      }
      continue;
    }

    if ("id" in msg && msg.id === reqId) {
      if ("error" in msg) console.error(`[error] ${JSON.stringify(msg.error)}`);
      break;
    }
  }

  return collectedText.join("");
}

async function main() {
  console.error("[*] Starting kimi --wire ...");
  const proc = spawn("kimi", ["--wire"], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  const reader = new WireReader(rl);

  const initReq = makeRequest("initialize", {
    protocol_version: "1.7",
    client: { name: "basic-wire-poc", version: "0.1.0" },
    capabilities: { supports_question: true, supports_plan_mode: true },
  });
  send(proc, initReq);

  while (true) {
    const msg = await reader.recv();
    if (!msg) continue;
    if ("id" in msg && msg.id === initReq.id) {
      if ("result" in msg) console.error("[*] Initialized successfully");
      else if ("error" in msg) console.error(`[!] Initialize error: ${JSON.stringify(msg.error)}`);
      break;
    }
  }

  for (const promptText of ["hello", "write me a haiku"]) {
    console.log(`\n[User] ${promptText}`);
    const reply = await runPrompt(proc, reader, promptText);
    console.log(`[Kimi] ${reply}`);
  }

  proc.stdin!.end();
  proc.kill();
  console.error("\n[*] Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
