import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { accountIdFrom, jwtClaims, EXPIRY_SKEW_MS, type CodexAuthSource } from "./codex-auth.js";

/**
 * Node-only: `openai-codex` on the laptop BORROWS the operator's Codex login
 * from `$CODEX_HOME/auth.json` (default ~/.codex), read-only. It never
 * refreshes that login and never writes the file.
 *
 * Why read-only (found live 2026-10-11): the file is shared with every Codex
 * surface on the machine, including the ChatGPT desktop app's built-in Codex,
 * which holds its tokens IN MEMORY. A refresh rotates the refresh token, so
 * refreshing from here left the app holding a spent one; the login broke,
 * auth.json vanished, and a new login had to be minted. Codex refreshes its
 * own login whenever it is used, and the access token lasts ~10 days, so a
 * borrower never needs to refresh — only to say so when the token runs out.
 *
 * A Codex install configured for the OS keyring has no auth.json; the error
 * says so rather than guessing.
 */
type AuthJson = {
  tokens?: { id_token?: unknown; access_token?: string; refresh_token?: string; account_id?: string };
};

export function codexAuthJsonPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json");
}

export function fileCodexAuth(
  env?: Record<string, string | undefined>,
  now: () => number = Date.now,
): CodexAuthSource {
  const file = codexAuthJsonPath({ ...process.env, ...(env ?? {}) });
  const relogin =
    "open Codex (the CLI or the app) once so it refreshes its own login, then rerun — anima-mesh never refreshes a login it shares";
  return async ({ force } = {}) => {
    let json: AuthJson | undefined;
    try {
      json = JSON.parse(await readFile(file, "utf8")) as AuthJson;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const t = json?.tokens;
    if (!t?.access_token) {
      throw new Error(
        `openai-codex: no Codex login at ${file} — run \`codex login\` (if your install stores credentials in the OS keyring, set cli_auth_credentials_store = "file")`,
      );
    }
    const exp = jwtClaims(t.access_token)?.exp;
    // Re-read per call: Codex may have refreshed since the last run. A forced
    // call means the endpoint just 401'd this token; refreshing is not ours
    // to do, so the run fails with the fix named.
    if (typeof exp === "number" && exp * 1000 - EXPIRY_SKEW_MS <= now()) {
      throw new Error(`openai-codex: the Codex login's access token at ${file} has expired — ${relogin}`);
    }
    if (force) {
      throw new Error(`openai-codex: the endpoint rejected the Codex login's access token — ${relogin}`);
    }
    const idToken = typeof t.id_token === "string" ? t.id_token : undefined;
    return { accessToken: t.access_token, accountId: t.account_id ?? accountIdFrom(idToken, t.access_token) };
  };
}
