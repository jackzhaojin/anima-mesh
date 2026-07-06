#!/usr/bin/env npx tsx
/**
 * Agent Stream JSON Log — Kimi CLI Print Mode PoC.
 *
 * Runs a complex multi-tool prompt via --print --output-format=stream-json,
 * logs every JSONL line to console and to a timestamped file in output/.
 * Best for: debugging verbosity, understanding what print mode exposes.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

const PROMPT =
  "Search the web for 'Kimi K2.5 latest features March 2026', " +
  "then run 'node -v && npm -v' in the shell to check local versions, " +
  "and finally use Glob to find all .md files in the project root. " +
  "Give me a concise summary of what you found from all three sources.";

async function main() {
  const outDir = path.join(import.meta.dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(outDir, `stream-json-${timestamp}.jsonl`);
  const logStream = fs.createWriteStream(logFile, { flags: "a" });

  console.log("=== Agent Stream JSON Log Demo ===\n");
  console.log(`[User] ${PROMPT}\n`);
  console.log(`[log] Writing raw JSONL to: ${logFile}\n`);

  const proc = spawn(
    "kimi",
    ["--print", "-p", PROMPT, "--output-format=stream-json"],
    { cwd: "/Users/jackjin/dev/continuous-agent-develop" }
  );

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  let lineCount = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    lineCount++;

    // Write raw JSONL to file
    logStream.write(line + "\n");

    // Pretty-print to console
    try {
      const msg = JSON.parse(line);
      const prefix = `[${msg.role}]`;

      if (msg.role === "assistant") {
        console.log(`${prefix} assistant message #${lineCount}`);
        if (msg.content) {
          const text = typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
          console.log(`  content: ${text.slice(0, 300)}${text.length > 300 ? "..." : ""}`);
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            console.log(`  -> tool_call: ${tc.function.name}`);
            console.log(`     args: ${tc.function.arguments}`);
          }
        }
      } else if (msg.role === "tool") {
        console.log(`${prefix} tool result #${lineCount} (tool_call_id=${msg.tool_call_id})`);
        const text = typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
        console.log(`  output: ${text.slice(0, 300)}${text.length > 300 ? "..." : ""}`);
      } else {
        console.log(`${prefix} unknown role #${lineCount}`);
        console.log(`  raw: ${line.slice(0, 300)}`);
      }
      console.log("");
    } catch {
      console.log(`[raw] ${line}`);
    }
  }

  logStream.end();
  console.log(`[done] Captured ${lineCount} JSONL lines in ${logFile}`);
}

main().catch(console.error);
