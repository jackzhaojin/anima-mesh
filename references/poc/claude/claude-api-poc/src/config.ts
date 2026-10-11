import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { resolve } from "node:path";

export const repoEnvFile = fileURLToPath(new URL("../../../../../.env.local", import.meta.url));
const chatEnvFile = fileURLToPath(new URL("../../chat-cli/.env", import.meta.url));

export function loadKey(env: NodeJS.ProcessEnv = process.env): string {
  // An explicit file takes precedence. Otherwise allow an exported key, then
  // use the repository's .env.local or the sibling chat-cli/.env, independent
  // of the caller's directory. Never copy credentials into this PoC.
  if (!env.CLAUDE_API_ENV_FILE && env.CLAUDE_API_KEY?.trim()) return env.CLAUDE_API_KEY.trim();
  const path = env.CLAUDE_API_ENV_FILE ? resolve(env.CLAUDE_API_ENV_FILE)
    : existsSync(repoEnvFile) ? repoEnvFile : chatEnvFile;
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new Error("Cannot read .env.local. Set CLAUDE_API_ENV_FILE to its path, or export CLAUDE_API_KEY.");
  }
  const key = parseEnv(contents).CLAUDE_API_KEY?.trim();
  if (!key) throw new Error("The selected env file must contain a nonempty CLAUDE_API_KEY.");
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
