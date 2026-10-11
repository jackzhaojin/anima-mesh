import { getEnv } from "../instance/env-core.js";

/**
 * ChatGPT-plan (Codex subscription) credentials for the `openai-codex`
 * harness — Workers-safe helpers: no fs, no node:*.
 *
 * The engine NEVER refreshes a Codex login. Refresh tokens rotate, and the
 * laptop's login is shared with Codex surfaces that cache tokens in memory
 * (the ChatGPT desktop app): refreshing from here broke that copy, live
 * 2026-10-11. The access token lasts ~10 days and Codex refreshes it
 * whenever it is used, so the laptop borrows it read-only
 * (codex-auth-file.ts). There is no cloud owner to refresh for either:
 * chatgpt.com blocks Cloudflare Workers egress by IP
 * (docs/learnings/2026-10-11-chatgpt-codex-blocks-workers.md).
 */

/** What a request needs: the bearer and the ChatGPT account it acts for. */
export interface CodexAuth {
  accessToken: string;
  accountId?: string;
}

/** `force` = the endpoint just 401'd this token. */
export type CodexAuthSource = (opts?: { force?: boolean }) => Promise<CodexAuth>;

/** Never hand out a token that would expire mid-run. */
export const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** JWT payload without verification — only read for exp and claims the server already trusts. */
export function jwtClaims(token: string | undefined): Record<string, any> | undefined {
  const part = token?.split(".")[1];
  if (!part) return undefined;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(atob(b64));
  } catch {
    return undefined;
  }
}

/** The ChatGPT account id rides in the tokens' `https://api.openai.com/auth` claim. */
export function accountIdFrom(...tokens: Array<string | undefined>): string | undefined {
  for (const t of tokens) {
    const id = jwtClaims(t)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/** True while the token's `exp` is more than the skew away. */
export function tokenFresh(accessToken: string | undefined, now: number): boolean {
  const exp = jwtClaims(accessToken)?.exp;
  return typeof exp === "number" && exp * 1000 - EXPIRY_SKEW_MS > now;
}

/**
 * The context-free fallback: a static CODEX_ACCESS_TOKEN (+ optional
 * CODEX_ACCOUNT_ID), never refreshed. Node entrypoints replace it with the
 * auth.json borrower (node-providers.ts).
 */
export function staticCodexAuth(
  opts: { env?: Record<string, string | undefined>; now?: () => number } = {},
): CodexAuthSource {
  const env = opts.env ?? {};
  const now = opts.now ?? Date.now;
  return async ({ force } = {}) => {
    const accessToken = getEnv(env, "CODEX_ACCESS_TOKEN");
    if (!accessToken || force || !tokenFresh(accessToken, now())) {
      throw new Error(
        "openai-codex: no usable access token — run on a laptop logged in with `codex login` (the engine borrows it read-only and never refreshes it)",
      );
    }
    return { accessToken, accountId: getEnv(env, "CODEX_ACCOUNT_ID") ?? accountIdFrom(accessToken) };
  };
}
