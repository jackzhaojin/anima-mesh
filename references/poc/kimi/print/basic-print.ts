#!/usr/bin/env npx tsx
/**
 * Basic Kimi CLI Print Mode PoC.
 * Uses --quiet for simple, final-text-only output.
 * Best for: quick scripts, CI/CD, when you only need the answer.
 */

import { execSync } from "child_process";

function runKimi(prompt: string): string {
  const cmd = `kimi --quiet -p ${JSON.stringify(prompt)}`;
  return execSync(cmd, { encoding: "utf-8", cwd: "/Users/jackjin/dev/continuous-agent-develop" });
}

async function main() {
  console.log("=== Basic Print Mode Demo ===\n");

  for (const prompt of ["hello", "write me a haiku about coding"]) {
    console.log(`[User] ${prompt}`);
    const reply = runKimi(prompt).trim();
    console.log(`[Kimi] ${reply}\n`);
  }
}

main().catch(console.error);
