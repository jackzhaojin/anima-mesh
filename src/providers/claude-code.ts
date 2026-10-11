import { spawn, spawnSync } from "node:child_process";
import type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";
import type { ApiProviderContext } from "./moonshot-api.js";
import { CLI_AUTH_ENV, CLI_STRIP_ENV, failureDetail, subprocessEnv } from "./subprocess-env.js";

/**
 * Claude Code headless (`claude -p`) — the default harness for high-trust
 * jobs. Auth rides on the local claude login or CLAUDE_CODE_OAUTH_TOKEN,
 * from the shell or the instance env (only CLAUDE_CODE_OAUTH_TOKEN crosses
 * from the instance; see subprocess-env.ts). An exported ANTHROPIC_API_KEY
 * is stripped from the subprocess: the CLI would prefer it and silently bill
 * API credits. Metered Claude is the `*-api-key` harnesses' job, chosen by
 * the brain, never by the shell.
 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function createClaudeCodeProvider(ctx: ApiProviderContext = {}): AgentWorkerProvider {
  const instanceEnv = ctx.env ?? {};
  return {
    name: "claude-code",
    // The CLI grants its own read tools against `cwd`. Web is deliberately
    // UNDER-claimed: `claude -p` runs with default permissions here (no
    // --allowedTools), so web access depends on the local install's settings
    // and is not something this seam can promise. Under-claiming costs a
    // sentence of prompt; over-claiming costs a fabricated research week.
    capabilities: { fileReads: true, webSearch: false },

    assertConfigured(): void {
      const which = process.platform === "win32" ? "where" : "which";
      const res = spawnSync(which, ["claude"], { stdio: "ignore" });
      if (res.status !== 0) {
        throw new Error(
          "claude-code harness: `claude` CLI not found on PATH — install Claude Code or pick another harness",
        );
      }
    },

    run(opts: ProviderRunOptions): Promise<ProviderResult> {
      const args = ["-p", opts.prompt, "--output-format", "text"];
      if (opts.model) args.push("--model", opts.model);
      opts.onProgress?.(`claude-code: starting headless run${opts.model ? ` (${opts.model})` : ""}`);

      return new Promise<ProviderResult>((resolve, reject) => {
        const proc = spawn("claude", args, {
          cwd: opts.cwd,
          env: subprocessEnv(instanceEnv, CLI_AUTH_ENV["claude-code"] ?? [], CLI_STRIP_ENV["claude-code"]),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          proc.kill("SIGTERM");
          reject(new Error(`claude-code run timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
        }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        proc.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
        proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
        proc.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) {
            opts.onProgress?.("claude-code: done");
            resolve({ text: stdout.trim() });
          } else {
            reject(new Error(`claude-code exited ${code}: ${failureDetail(stderr, stdout)}`));
          }
        });
      });
    },
  };
}

/** Context-free instance: shell env only (resolveProvider without a ctx). */
export const claudeCodeProvider: AgentWorkerProvider = createClaudeCodeProvider();
