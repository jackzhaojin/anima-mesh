import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Import-hygiene guard (D12 + platform): nothing reachable from the Worker
 * entry may import node built-ins or the subprocess/filesystem modules.
 * Walks the static import graph; `import type` lines are erased at build
 * and therefore ignored.
 */
const ROOT = path.resolve(__dirname, "..");
const ENTRIES = [
  path.join(ROOT, "workers/heartbeat/src/index.ts"),
  path.join(ROOT, "workers/web/src/index.ts"),
];

const ALLOWED_BARE = new Set(["yaml", "cloudflare:workers"]);
const BANNED_FILES = [
  "src/instance/store-fs.ts",
  "src/instance/env.ts",
  "src/instance/config.ts",
  "src/okf/bundle.ts",
  "src/okf/conformance-fs.ts",
  "src/providers/claude-code.ts",
  "src/providers/opencode.ts",
  "src/providers/claude-agent-sdk.ts",
  "src/providers/node-providers.ts",
  "src/harness/run.ts",
  "src/harness/heartbeat.ts",
  "src/harness/verifiers.ts",
  "src/channels/index.ts",
].map((p) => path.join(ROOT, p));

/** Matches runtime imports/re-exports; skips pure `import type`. */
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\s)[^"']*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // bare specifier
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidate = base.endsWith(".js") ? base.slice(0, -3) + ".ts" : base + ".ts";
  return candidate;
}

function walk(entry: string): { visited: Set<string>; bare: Set<string> } {
  const visited = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2]!;
      const resolved = resolveSpecifier(file, spec);
      if (resolved === null) {
        bare.add(spec);
      } else {
        queue.push(resolved);
      }
    }
  }
  return { visited, bare };
}

describe.each(ENTRIES.map((entry) => [path.relative(ROOT, entry), entry] as const))(
  "workers import hygiene: %s",
  (_label, entry) => {
    const { visited, bare } = walk(entry);

    it("reaches the engine core (sanity: the walk actually followed imports)", () => {
      expect(visited.size).toBeGreaterThan(5);
      expect([...visited].some((f) => f.endsWith("store-github.ts"))).toBe(true);
    });

    it("imports no node built-ins anywhere in the graph", () => {
      const nodeSpecs = [...bare].filter((s) => s.startsWith("node:"));
      expect(nodeSpecs).toEqual([]);
    });

    it("uses only allowlisted bare specifiers", () => {
      const unexpected = [...bare].filter((s) => !ALLOWED_BARE.has(s));
      expect(unexpected).toEqual([]);
    });

    it("never touches the subprocess/filesystem modules", () => {
      const banned = BANNED_FILES.filter((f) => visited.has(f));
      expect(banned.map((f) => path.relative(ROOT, f))).toEqual([]);
    });
  },
);
