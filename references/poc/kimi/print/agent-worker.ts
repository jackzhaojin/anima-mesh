#!/usr/bin/env npx tsx
/**
 * Agent Worker Kimi CLI Print Mode PoC.
 * Uses --print --output-format=stream-json for structured JSONL output.
 * Best for: programmatic agents, tool-call observability, worker pipelines.
 */

import { spawn } from "child_process";
import * as readline from "readline";

interface Message {
  role: "user" | "assistant" | "tool";
  content?: string | Array<{ type: string; text?: string; think?: string }>;
  tool_calls?: Array<{
    type: "function";
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function runKimiJson(prompt: string): Promise<Message[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "kimi",
      ["--print", "-p", prompt, "--output-format=stream-json"],
      { cwd: "/Users/jackjin/dev/continuous-agent-develop" }
    );

    const messages: Message[] = [];
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        messages.push(JSON.parse(line) as Message);
      } catch {
        console.error("[!] Bad JSON:", line);
      }
    });

    rl.on("close", () => resolve(messages));
    proc.on("error", reject);
  });
}

function formatContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part.type === "text") return part.text ?? "";
        if (part.type === "think") return `[think: ${part.think ?? ""}]`;
        return JSON.stringify(part);
      })
      .join("");
  }
  return JSON.stringify(content);
}

function formatMessage(msg: Message): string {
  if (msg.role === "assistant") {
    let out = formatContent(msg.content);
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      out += "\n  [tool_calls]:";
      for (const tc of msg.tool_calls) {
        out += `\n    - ${tc.function.name}(${tc.function.arguments})`;
      }
    }
    return out;
  }
  if (msg.role === "tool") {
    return `[tool result ${msg.tool_call_id}] ${formatContent(msg.content)}`;
  }
  return JSON.stringify(msg);
}

async function main() {
  console.log("=== Agent Worker Print Mode Demo (JSONL) ===\n");

  const prompt = "List all TypeScript files in the references/poc/kimi directory";
  console.log(`[User] ${prompt}\n`);

  const messages = await runKimiJson(prompt);
  for (const msg of messages) {
    console.log(`[${msg.role}]`);
    console.log(formatMessage(msg));
    console.log();
  }
}

main().catch(console.error);
