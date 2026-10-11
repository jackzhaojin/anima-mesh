import { spawn, spawnSync } from "node:child_process";
import type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";

/**
 * Codex headless (`codex exec --json`) — OpenAI's agent CLI as a laptop-tier
 * harness. Auth rides on the local `codex login` (a ChatGPT plan, i.e. the
 * subscription); no key material passes through the engine. CODEX_API_KEY /
 * OPENAI_API_KEY are stripped from the subprocess so an exported key never
 * silently moves a subscription run onto metered API billing — the same
 * "billing is the harness's choice" rule the Claude harnesses follow.
 *
 * The event stream is the one references/poc/codex verified through the
 * SDK (which wraps this same command): thread.started, item.* (agent_message,
 * command_execution, ...), turn.completed with usage, turn.failed, error.
 *
 * The prompt goes over STDIN (`-`), never argv: assembled prompts with
 * inlined sources exceed Linux's 128 KiB per-argument limit.
 */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const STRIPPED_ENV = ["CODEX_API_KEY", "OPENAI_API_KEY"];

/** argv for one run — exported so the shape is testable without spawning. */
export function codexExecArgs(opts: Pick<ProviderRunOptions, "cwd" | "model" | "webSearchMaxUses">): string[] {
  const args = [
    "exec",
    "--json",
    // The L1 contract: the worker READS; the harness writes artifacts.
    "--sandbox",
    "read-only",
    // Instance roots are often not git repos (and remote brains never are).
    "--skip-git-repo-check",
    // A beat is one-shot; nothing to resume, so no rollout files.
    "--ephemeral",
    "--color",
    "never",
    "--cd",
    opts.cwd,
    // Web is OFF unless the agent concept budgets it (`web:`): codex's own
    // default is "cached" search, which an agent that never asked for the
    // web must not get. The count itself is enforced by the prompt, not here.
    "-c",
    `web_search="${(opts.webSearchMaxUses ?? 0) > 0 ? "live" : "disabled"}"`,
  ];
  if (opts.model) args.push("--model", opts.model);
  args.push("-"); // prompt from stdin
  return args;
}

/** Reduce the JSONL event stream to the final answer, usage, and any failure. */
export function parseCodexEvents(
  stdout: string,
  onEvent: (note: string) => void = () => {},
): { text: string; usage?: unknown; error?: string; lastError?: string } {
  let text = "";
  let usage: unknown;
  let error: string | undefined;
  let lastError: string | undefined;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    switch (ev.type) {
      case "item.started":
        if (ev.item?.type === "command_execution") onEvent(`codex → ${String(ev.item.command ?? "").slice(0, 120)}`);
        else if (ev.item?.type === "web_search") onEvent(`codex → web search: ${String(ev.item.query ?? "").slice(0, 120)}`);
        break;
      case "item.completed":
        // The LAST agent message is the answer; earlier ones are narration.
        if (ev.item?.type === "agent_message" && typeof ev.item.text === "string") text = ev.item.text;
        break;
      case "turn.completed":
        usage = ev.usage;
        break;
      case "turn.failed":
        error = String(ev.error?.message ?? "turn failed");
        break;
      case "error":
        // NOT fatal: codex emits these for transient reconnects
        // ("Reconnecting... 2/5") and may still complete the turn — only
        // turn.failed ends it (seen live, codex-cli 0.162.1). Kept as the
        // diagnosis if the process dies without a turn.failed.
        lastError = String(ev.message ?? "error");
        onEvent(`codex: ${lastError.slice(0, 120)}`);
        break;
      default:
        break;
    }
  }
  return { text: text.trim(), usage, error, lastError };
}

export const codexProvider: AgentWorkerProvider = {
  name: "codex",
  // A read-only sandbox still reads the working tree; web search is set
  // explicitly per run (codexExecArgs), so both answers are facts.
  capabilities: { fileReads: true, webSearch: true },

  assertConfigured(): void {
    const which = process.platform === "win32" ? "where" : "which";
    const res = spawnSync(which, ["codex"], { stdio: "ignore" });
    if (res.status !== 0) {
      throw new Error(
        "codex harness: `codex` CLI not found on PATH — install Codex (npm i -g @openai/codex), run `codex login`, or pick another harness",
      );
    }
  },

  run(opts: ProviderRunOptions): Promise<ProviderResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const progress = opts.onProgress ?? (() => {});
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const v of STRIPPED_ENV) delete env[v];
    progress(`codex: starting headless run${opts.model ? ` (${opts.model})` : ""}`);

    return new Promise<ProviderResult>((resolve, reject) => {
      const proc = spawn("codex", codexExecArgs(opts), { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let pending = "";
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`codex run timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout.on("data", (b: Buffer) => {
        const chunk = b.toString();
        stdout += chunk;
        // Live progress from complete lines only; the final parse re-reads all.
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        parseCodexEvents(lines.join("\n"), progress);
      });
      proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        const { text, usage, error, lastError } = parseCodexEvents(stdout);
        if (code === 0 && !error && text) {
          progress("codex: done");
          resolve({ text, tokens: usage });
          return;
        }
        const why = error ?? lastError ?? (text ? "" : "no agent message in the event stream");
        reject(new Error(`codex exited ${code}${why ? `: ${why}` : ""}${stderr ? ` — ${stderr.slice(0, 400)}` : ""}`));
      });
      proc.stdin.end(opts.prompt);
    });
  },
};
