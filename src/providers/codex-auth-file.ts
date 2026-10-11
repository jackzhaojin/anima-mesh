import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { codexAuthSource, type CodexAuthSource, type CodexTokenStore } from "./codex-auth.js";

/**
 * Node-only: the laptop's Codex token store IS the Codex CLI's own
 * `$CODEX_HOME/auth.json` (default ~/.codex). `openai-codex` on the laptop
 * then shares the operator's `codex login`, re-reading the file before
 * every use and writing rotated tokens back in place exactly as the CLI
 * does — so neither side ever presents a refresh token the other spent.
 *
 * A Codex install configured for the OS keyring has no auth.json; the
 * error says so rather than guessing.
 */
type AuthJson = {
  tokens?: { id_token?: unknown; access_token?: string; refresh_token?: string; account_id?: string };
  last_refresh?: string;
  [k: string]: unknown;
};

export function codexAuthJsonPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json");
}

export function authJsonTokenStore(file: string): CodexTokenStore {
  const read = async (): Promise<AuthJson | undefined> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as AuthJson;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  };
  return {
    async load() {
      const t = (await read())?.tokens;
      if (!t?.refresh_token) return undefined;
      return {
        refreshToken: t.refresh_token,
        accessToken: t.access_token,
        idToken: typeof t.id_token === "string" ? t.id_token : undefined,
        accountId: t.account_id,
      };
    },
    async save(tokens) {
      const current = (await read()) ?? {};
      const next: AuthJson = {
        ...current,
        tokens: {
          ...(current.tokens ?? {}),
          ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          ...(tokens.accountId ? { account_id: tokens.accountId } : {}),
        },
        last_refresh: new Date().toISOString(),
      };
      // Atomic replace: a half-written auth.json would lose the only copy of
      // a freshly rotated refresh token.
      const tmp = `${file}.anima-mesh-${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(tmp, file);
    },
  };
}

/** One source per auth.json per process, so every run shares one refresh mutex. */
const sources = new Map<string, CodexAuthSource>();

export function fileCodexAuth(env?: Record<string, string | undefined>): CodexAuthSource {
  const file = codexAuthJsonPath({ ...process.env, ...(env ?? {}) });
  let source = sources.get(file);
  if (!source) {
    const inner = codexAuthSource(authJsonTokenStore(file), { seedFromEnv: false });
    source = async (o) => {
      try {
        return await inner(o);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("no Codex login")) {
          throw new Error(
            `openai-codex: no Codex login at ${file} — run \`codex login\` (if your install stores credentials in the OS keyring, set cli_auth_credentials_store = "file")`,
          );
        }
        throw err;
      }
    };
    sources.set(file, source);
  }
  return source;
}
