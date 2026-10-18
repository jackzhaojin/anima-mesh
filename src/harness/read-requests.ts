import { parse as parseYaml } from "yaml";
import type { InstanceStore } from "../instance/store.js";
import type { InstanceConfig } from "../instance/config-core.js";
import type { AgentConcept } from "../agents/concept.js";
import type { SourceContext } from "../sources/types.js";
import { readCabinetPath } from "../sources/msgraph.js";
import { readDocsFile } from "../sources/github-docs.js";
import { readBrainPath } from "../sources/brains.js";
import { readGmailMessage, readDriveFile } from "../sources/google.js";

/**
 * Ask-driven retrieval (v0.17.0) — the third propose/dispose surface beside
 * `schedule-request` and `draft-request`, but for READS.
 *
 * The inline heuristics (README-first, most-recent) can never know what THIS
 * run is about: "read my 2015 agreement" loses every recency race. Choosing
 * files is judgment, and judgment belongs to the model (design invariant #2)
 * — so the model ends its output with a `read-request` block naming paths it
 * saw in a listing, and deterministic code validates, serves, and ledgers.
 * The harness then runs the agent ONCE more with the served contents
 * inlined. Harness-agnostic: pure text in, text out — works on providers
 * with no tool protocol at all.
 *
 * Every refusal is a visible line in the served section — undeclared source,
 * jailed path, budget exhaustion — never a silent drop (capability truth).
 *
 * ```read-request
 * onedrive: [Legal/Agreements/employment.pdf]
 * bundle: [cabinet/some-concept.md]
 * ```
 */

const BLOCK_RE = /```read-request\s*\r?\n([\s\S]*?)```/g;

export const MAX_REQUEST_FILES = 4;
export const PER_FILE_CHARS = 12_000;
export const TOTAL_READ_CHARS = 32_000;

/** Sentinel source for a block whose YAML did not parse — refused out loud. */
const MALFORMED = "(malformed)";

export interface ReadRequest {
  source: string;
  path: string;
}

export function parseReadRequests(text: string): ReadRequest[] {
  const requests: ReadRequest[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    let parsed: unknown;
    try {
      parsed = parseYaml(m[1]!);
    } catch (err) {
      requests.push({ source: MALFORMED, path: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      requests.push({ source: MALFORMED, path: "block must be `source: [path, …]` mappings" });
      continue;
    }
    for (const [source, value] of Object.entries(parsed as Record<string, unknown>)) {
      const paths = Array.isArray(value) ? value : [value];
      for (const p of paths) {
        if (typeof p === "string" && p.trim() !== "") requests.push({ source, path: p.trim() });
      }
    }
  }
  return requests;
}

export function stripReadRequests(text: string): string {
  return text.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export interface ServedReads {
  /** The prompt section to append for the continuation run. */
  section: string;
  requested: number;
  served: number;
  refused: number;
  chars: number;
}

/**
 * Serve a parsed request list within the caps. Reads have no side effects
 * (L1-safe), so there is no approval gate — but the source allowlist and the
 * path jail are code, not prompt.
 */
export async function serveReadRequests(opts: {
  requests: ReadRequest[];
  agent: AgentConcept;
  store: InstanceStore;
  config: InstanceConfig;
  sourceCtx: SourceContext;
}): Promise<ServedReads> {
  const { requests, agent, store, config } = opts;
  // Config-driven sources ('brains') resolve links from the reading brain's
  // own config - supplied here so no caller can forget it.
  const sourceCtx: SourceContext = { ...opts.sourceCtx, config: opts.sourceCtx.config ?? config };
  const allowed = new Set(["bundle", "reports", ...agent.sources]);
  const lines: string[] = [
    "\n## Requested reads (served at your request)",
    "You asked for the files below; each is served, or its refusal stated. No further",
    "read-requests will be served this run — produce your complete final output now.",
  ];
  let served = 0;
  let refused = 0;
  let spent = 0;

  const take = requests.slice(0, MAX_REQUEST_FILES);
  for (const req of take) {
    if (req.source === MALFORMED) {
      refused++;
      lines.push(`\n#### (unparseable read-request block)\n\n_(refused: ${req.path})_`);
      continue;
    }
    const label = `${req.source}: ${req.path}`;
    if (!allowed.has(req.source)) {
      refused++;
      lines.push(`\n#### ${label}\n\n_(refused: source '${req.source}' is not available to this agent — you may name: ${[...allowed].join(", ")})_`);
      continue;
    }
    if (req.path.startsWith("/") || req.path.includes("\\") || req.path.split("/").includes("..")) {
      refused++;
      lines.push(`\n#### ${label}\n\n_(refused: path escapes the jail — relative paths only, no '..')_`);
      continue;
    }
    const room = Math.min(req.source === "reports" ? TOTAL_READ_CHARS : PER_FILE_CHARS, TOTAL_READ_CHARS - spent);
    if (room <= 0) {
      refused++;
      lines.push(`\n#### ${label}\n\n_(refused: the ${TOTAL_READ_CHARS}-char read budget is spent)_`);
      continue;
    }
    try {
      let content: string;
      if (req.source === "reports") {
        // Listing membership is required in addition to the path jail.
        if (!(await store.listReports()).includes(req.path)) throw new Error("not found in the report listing");
        const raw = await store.readReport(req.path);
        content = raw.length > room ? raw.slice(0, room) + "\n…(truncated — report read budget exhausted)" : raw;
      } else if (req.source === "bundle") {
        const raw = await store.readOptional(`${config.bundle}/${req.path}`);
        if (raw === null) throw new Error("not found in the bundle");
        content = raw.length > room ? raw.slice(0, room) + "\n…(truncated)" : raw;
      } else if (req.source === "onedrive") {
        content = await readCabinetPath(sourceCtx, req.path, { maxChars: room });
      } else if (req.source === "github-docs") {
        content = await readDocsFile(sourceCtx, req.path, { maxChars: room });
      } else if (req.source === "brains") {
        content = await readBrainPath(sourceCtx, req.path, { maxChars: room });
      } else if (req.source === "gmail") {
        content = await readGmailMessage(sourceCtx, req.path, { maxChars: room });
      } else if (req.source === "google-drive") {
        content = await readDriveFile(sourceCtx, req.path, { maxChars: room });
      } else {
        throw new Error(`the engine cannot serve reads from source '${req.source}'`);
      }
      served++;
      spent += content.length;
      lines.push(`\n#### ${label}\n\n\`\`\`\n${content}\n\`\`\``);
    } catch (err) {
      refused++;
      const message = err instanceof Error ? err.message : String(err);
      lines.push(`\n#### ${label}\n\n_(read failed: ${message})_`);
    }
  }
  if (requests.length > take.length) {
    lines.push(
      `\n_(${requests.length - take.length} more request(s) dropped — the cap is ${MAX_REQUEST_FILES} files per run: ${requests
        .slice(take.length)
        .map((r) => r.path)
        .join(", ")})_`,
    );
  }
  return { section: lines.join("\n"), requested: requests.length, served, refused, chars: spent };
}

/** The capability contract lines announcing the surface — stated to every agent. */
/** What a request path looks like for each source - the example names the right shape. */
const EXAMPLE_PATHS: Record<string, string> = {
  bundle: "facts/some-concept.md",
  reports: "<filename-from-the-report-listing>.md",
  onedrive: "Folder/File.pdf",
  "github-docs": "path/in/repo.md",
  brains: "<brain-id>/ops/calendar.md",
  gmail: "<message-id>",
  "google-drive": "<file-id>",
};

export function readRequestCapabilityLines(agent: AgentConcept): string[] {
  const sources = ["bundle", "reports", ...agent.sources];
  const example = agent.sources.find((s) => s in EXAMPLE_PATHS) ?? "bundle";
  return [
    "- **On-demand reads (one round):** if the task needs a specific file you can see in a listing",
    "  below — or a bundle concept not already inlined — END your output with exactly this block:",
    "  ```read-request",
    "  " + example + ": [" + (EXAMPLE_PATHS[example] ?? "path") + "]",
    "  ```",
    `  Sources you may name: ${sources.join(", ")}. The harness serves the files (cabinet PDFs`,
    `  included) and runs you once more with them inlined — up to ${MAX_REQUEST_FILES} files / ~${Math.round(TOTAL_READ_CHARS / 1000)}K chars,`,
    "  ONE round only. Ask only when the inlined context is insufficient — a request costs a",
    "  second full run.",
  ];
}
