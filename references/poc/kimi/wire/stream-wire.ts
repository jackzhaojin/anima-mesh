#!/usr/bin/env npx tsx
/**
 * Advanced Kimi Code CLI Wire mode client.
 * Features: interactive REPL, real-time streaming, rich event logging,
 * /cancel and /quit commands, full approval/question/tool handling.
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

interface JSONRPCNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type WireMessage = JSONRPCRequest | JSONRPCNotification | JSONRPCResponse;

function makeRequest(method: string, params: Record<string, unknown>): JSONRPCRequest {
  return { jsonrpc: "2.0", method, id: randomUUID(), params };
}

function send(proc: ChildProcess, msg: WireMessage): void {
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}

function logEvent(type: string, detail: string): void {
  console.error(`\x1b[2m[wire:${type}] ${detail}\x1b[0m`);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
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

async function runPrompt(proc: ChildProcess, reader: WireReader, text: string): Promise<void> {
  const req = makeRequest("prompt", { user_input: text });
  send(proc, req);
  const reqId = req.id;
  let inTurn = true;

  while (inTurn) {
    const msg = await reader.recv();
    if (!msg) continue;

    if ("method" in msg && !("id" in msg)) {
      if (msg.method === "event") {
        const params = msg.params || {};
        const evtType = params.type as string;
        const payload = (params.payload as Record<string, unknown>) || {};

        switch (evtType) {
          case "TurnBegin":
            logEvent("turn", "begin");
            break;
          case "TurnEnd":
            logEvent("turn", "end");
            break;
          case "StepBegin":
            logEvent("step", `begin #${payload.n}`);
            break;
          case "StepInterrupted":
            logEvent("step", "interrupted");
            break;
          case "CompactionBegin":
            logEvent("compact", "begin");
            break;
          case "CompactionEnd":
            logEvent("compact", "end");
            break;
          case "ContentPart":
            if (payload.type === "text") process.stdout.write(payload.text as string);
            else if (payload.type === "think") logEvent("think", payload.think as string);
            break;
          case "ToolCall":
            logEvent("tool", `call ${(payload.function as any)?.name ?? "?"}`);
            break;
          case "ToolResult": {
            const rv = payload.return_value as Record<string, unknown> | undefined;
            logEvent("tool", `result is_error=${rv?.is_error ?? "?"}`);
            break;
          }
          case "StatusUpdate": {
            const usage = payload.token_usage as Record<string, number> | undefined;
            const ctx = payload.context_usage as number | undefined;
            const parts: string[] = [];
            if (usage) {
              const total =
                (usage.input_other || 0) +
                (usage.input_cache_read || 0) +
                (usage.input_cache_creation || 0) +
                (usage.output || 0);
              parts.push(`tokens=${formatTokens(total)}`);
            }
            if (typeof ctx === "number") parts.push(`ctx=${(ctx * 100).toFixed(1)}%`);
            if (parts.length) logEvent("status", parts.join(" "));
            break;
          }
          case "SteerInput":
            logEvent("steer", "input consumed");
            break;
          case "PlanDisplay":
            logEvent("plan", `file=${payload.file_path}`);
            break;
          case "HookTriggered":
            logEvent("hook", `triggered ${payload.event} -> ${payload.target}`);
            break;
          case "HookResolved":
            logEvent("hook", `resolved ${payload.event} action=${payload.action}`);
            break;
          case "SubagentEvent": {
            const subEvt = payload.event as Record<string, unknown> | undefined;
            logEvent("subagent", `event=${subEvt?.type ?? "?"}`);
            break;
          }
          default:
            logEvent("event", `${evtType}`);
        }
      } else if (msg.method === "request") {
        const params = msg.params || {};
        const reqType = params.type as string;
        const payload = (params.payload as Record<string, unknown>) || {};
        const reqIdResp = (msg as JSONRPCRequest).id;

        if (reqType === "ApprovalRequest") {
          logEvent("approval", `${payload.sender}: ${payload.action}`);
          console.error(`  -> ${payload.description}`);
          send(proc, {
            jsonrpc: "2.0",
            id: reqIdResp,
            result: { request_id: payload.id, response: "approve" },
          } as JSONRPCResponse);
        } else if (reqType === "ToolCallRequest") {
          logEvent("ext-tool", `${payload.name}`);
          send(proc, {
            jsonrpc: "2.0",
            id: reqIdResp,
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
          logEvent("question", "received structured question");
          send(proc, {
            jsonrpc: "2.0",
            id: reqIdResp,
            result: { request_id: payload.id, answers: {} },
          } as JSONRPCResponse);
        } else if (reqType === "HookRequest") {
          logEvent("hook-req", `${payload.event} -> ${payload.target}`);
          send(proc, {
            jsonrpc: "2.0",
            id: reqIdResp,
            result: { request_id: payload.id, action: "allow", reason: "" },
          } as JSONRPCResponse);
        }
      }
      continue;
    }

    if ("id" in msg && msg.id === reqId) {
      if ("result" in msg) logEvent("prompt", `finished status=${(msg.result as any)?.status}`);
      else if ("error" in msg) logEvent("prompt", `error ${JSON.stringify(msg.error)}`);
      inTurn = false;
    }
  }

  process.stdout.write("\n");
}

async function sendCancel(proc: ChildProcess, reader: WireReader): Promise<void> {
  const req = makeRequest("cancel", {});
  send(proc, req);
  const reqId = req.id;

  while (true) {
    const msg = await reader.recv();
    if (!msg) continue;
    if ("id" in msg && msg.id === reqId) {
      if ("result" in msg) logEvent("cancel", "ok");
      else if ("error" in msg) logEvent("cancel", `error ${JSON.stringify(msg.error)}`);
      break;
    }
  }
}

async function main() {
  console.error("[*] Starting kimi --wire (advanced stream-cli)");
  console.error("[*] Type a message and press Enter. Commands: /cancel, /quit\n");

  const proc = spawn("kimi", ["--wire"], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  const reader = new WireReader(rl);

  const initReq = makeRequest("initialize", {
    protocol_version: "1.7",
    client: { name: "stream-wire-poc", version: "0.1.0" },
    capabilities: { supports_question: true, supports_plan_mode: true },
  });
  send(proc, initReq);

  while (true) {
    const msg = await reader.recv();
    if (!msg) continue;
    if ("id" in msg && msg.id === initReq.id) {
      if ("result" in msg) {
        const result = msg.result as Record<string, unknown>;
        const server = result.server as Record<string, string> | undefined;
        console.error(`[*] Initialized: ${server?.name ?? "?"} ${server?.version ?? ""}`);
      } else if ("error" in msg) {
        console.error(`[!] Initialize error: ${JSON.stringify(msg.error)}`);
      }
      break;
    }
  }

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
      await sendCancel(proc, reader);
      stdinRl.prompt();
      continue;
    }
    process.stdout.write("\x1b[1mKimi>\x1b[0m ");
    await runPrompt(proc, reader, input);
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
