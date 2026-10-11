import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { resolve } from "node:path";

export const pocEnvFile = fileURLToPath(new URL("../.env", import.meta.url));

export function loadKey(env: NodeJS.ProcessEnv = process.env): string {
  // An explicit file takes precedence. Otherwise allow an exported key, then
  // use this PoC's own .env, independent of the caller's directory.
  if (!env.CLAUDE_API_ENV_FILE && env.ANTHROPIC_API_KEY?.trim()) return env.ANTHROPIC_API_KEY.trim();
  const path = env.CLAUDE_API_ENV_FILE ? resolve(env.CLAUDE_API_ENV_FILE)
    : pocEnvFile;
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new Error("Cannot read the PoC's .env. Set CLAUDE_API_ENV_FILE to its path, or export ANTHROPIC_API_KEY.");
  }
  const key = parseEnv(contents).ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("The selected env file must contain a nonempty ANTHROPIC_API_KEY.");
  return key;
}

export function childEnv(key: string, configDir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Deliberately omit OAuth tokens, provider switches, endpoint overrides and
  // unrelated secrets. A fresh Claude config directory prevents login fallback.
  const result: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LANG", "LC_ALL"]) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  return {
    ...result,
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

export function canReadFixture(tool: string, input: unknown, fixture: string): boolean {
  if (tool !== "Read" || !input || typeof input !== "object") return false;
  return "file_path" in input && input.file_path === fixture;
}

export function redact(text: string, key: string): string {
  return text.split(key).join("[REDACTED]").replace(/sk-ant-[\w-]+/g, "[REDACTED]");
}
