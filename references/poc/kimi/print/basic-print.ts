#!/usr/bin/env npx tsx
/**
 * Basic Kimi CLI Print Mode PoC.
 * Uses -p for a single non-interactive prompt in text mode.
 * Best for: quick scripts, CI/CD, when you only need the answer.
 *
 * NOTE: written against legacy kimi-cli, which had `--quiet` for
 * final-text-only output. Kimi Code (0.27+) dropped it — `-p` is now the
 * non-interactive entry point, and its text output also carries reasoning
 * bullets and a "To resume this session" footer. Use --output-format
 * stream-json (see agent-worker.ts) when you need to isolate the final text.
 */

import { execSync } from "child_process";
import * as path from "path";

// Repo root, derived from this file's location — never a hardcoded machine path.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

function runKimi(prompt: string): string {
  const cmd = `kimi -p ${JSON.stringify(prompt)}`;
  return execSync(cmd, { encoding: "utf-8", cwd: REPO_ROOT });
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
