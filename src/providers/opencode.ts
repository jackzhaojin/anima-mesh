import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentWorkerProvider, ProviderRunOptions, ProviderResult } from "./types.js";

/**
 * opencode harness — drives any opencode-configured model headlessly via a
 * long-lived `opencode serve` (lazily started, reused, killed on exit).
 * Default model is Kimi K2.6 ("kimi-code/kimi-for-coding"), the proven
 * alternate-vendor pairing from the reference architecture: same seam,
 * different model vendor.
 *
 * Auth rides on opencode's own credential store (`opencode auth`) or
 * MOONSHOT_API_KEY in the environment — never on the engine.
 */
const DEFAULT_MODEL = "kimi-code/kimi-for-coding";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const SERVE_STARTUP_TIMEOUT_MS = 45_000;

interface OpencodeServer {
  base: string;
  proc: ChildProcess;
}

let serverPromise: Promise<OpencodeServer> | null = null;
let serverChild: ChildProcess | null = null;

function startServer(): Promise<OpencodeServer> {
  const workdir = path.join(tmpdir(), "anima-mesh-opencode");
  mkdirSync(workdir, { recursive: true });

  const proc = spawn(
    "opencode",
    ["serve", "--port", "0", "--hostname", "127.0.0.1"],
    { cwd: workdir, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  serverChild = proc;

  return new Promise<OpencodeServer>((resolve, reject) => {
    let settled = false;
    const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    const onData = (b: Buffer) => {
      const m = strip(b.toString()).match(/listening on\s+(https?:\/\/[^\s]+)/i);
      if (!settled && m) {
        settled = true;
        resolve({ base: m[1]!.replace(/\/+$/, ""), proc });
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => {
      serverPromise = null;
      serverChild = null;
      if (!settled) reject(new Error(`opencode serve exited early (code ${code})`));
    });
    setTimeout(() => !settled && reject(new Error("timed out waiting for opencode serve")), SERVE_STARTUP_TIMEOUT_MS);
  });
}

function getServer(): Promise<OpencodeServer> {
  if (!serverPromise) {
    serverPromise = startServer().catch((e) => {
      serverPromise = null;
      return Promise.reject(e);
    });
  }
  return serverPromise;
}

function killServer(): void {
  try {
    serverChild?.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}
process.once("exit", killServer);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    killServer();
    process.exit(0);
  });
}

async function postJson(base: string, p: string, body: unknown, timeoutMs = 30_000): Promise<any> {
  const res = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`opencode ${p} → HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  return res.json();
}

/** Tap the SSE /event stream and surface this session's tool firing via onProgress. */
function tapSession(base: string, sessionId: string, onProgress: (note: string) => void) {
  const ctrl = new AbortController();
  const seen = new Set<string>();

  (async () => {
    const res = await fetch(`${base}/event`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.startsWith("data: ") ? line.slice(6) : line;
        if (!t.trim()) continue;
        let ev: any;
        try {
          ev = JSON.parse(t);
        } catch {
          continue;
        }
        if (ev.type !== "message.part.updated") continue;
        const part = ev.properties?.part;
        if (!part || part.type !== "tool") continue;
        if (part.sessionID && part.sessionID !== sessionId) continue;
        const status: string = part.state?.status ?? "";
        const key = `${part.id}:${status}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (status === "running") onProgress(`opencode → ${part.tool ?? "tool"}`);
        else if (status === "error") onProgress(`opencode ✗ ${part.tool}: ${String(part.state?.error ?? "").slice(0, 120)}`);
      }
    }
  })().catch(() => {
    /* aborted or closed — expected at end of turn */
  });

  return { stop: () => ctrl.abort() };
}

export const opencodeProvider: AgentWorkerProvider = {
  name: "opencode",

  assertConfigured(): void {
    const which = process.platform === "win32" ? "where" : "which";
    const res = spawnSync(which, ["opencode"], { stdio: "ignore" });
    if (res.status !== 0) {
      throw new Error("opencode harness: `opencode` CLI not found on PATH — install opencode or pick another harness");
    }
  },

  async run(opts: ProviderRunOptions): Promise<ProviderResult> {
    const model = opts.model ?? DEFAULT_MODEL;
    const [providerID, modelID] = splitModel(model);
    const progress = opts.onProgress ?? (() => {});

    progress(`opencode: starting (${model})`);
    const { base } = await getServer();

    const session = await postJson(base, "/session", { title: "anima-mesh run" });
    const sessionId: string = session.id;
    const tap = tapSession(base, sessionId, progress);

    let message: any;
    try {
      message = await postJson(
        base,
        `/session/${sessionId}/message`,
        { providerID, modelID, parts: [{ type: "text", text: opts.prompt }] },
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    } finally {
      await new Promise((r) => setTimeout(r, 250));
      tap.stop();
    }

    if (message?.info?.error) {
      throw new Error(`opencode turn errored: ${JSON.stringify(message.info.error).slice(0, 300)}`);
    }

    const text = (message?.parts ?? [])
      .filter((p: { type: string; text?: string }) => p.type === "text" && typeof p.text === "string")
      .map((p: { text: string }) => p.text)
      .join("\n")
      .trim();

    progress("opencode: done");
    return { text, raw: message, tokens: message?.info?.tokens, costUsd: message?.info?.cost };
  },
};

/** "provider/model" → [providerID, modelID]; bare model falls back to kimi-code. */
function splitModel(model: string): [string, string] {
  const idx = model.indexOf("/");
  if (idx === -1) return ["kimi-code", model];
  return [model.slice(0, idx), model.slice(idx + 1)];
}
