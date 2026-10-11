import { getEnv } from "../instance/env-core.js";

/**
 * ChatGPT-plan (Codex subscription) OAuth for the `codex-api` harness —
 * Workers-safe: fetch only, no fs, no node:*.
 *
 * The constraint that shapes everything here: refresh tokens ROTATE. Each
 * refresh returns a new refresh token and spends the old one; presenting a
 * spent one fails (`refresh_token_reused`) and can revoke the whole login.
 * So a refresh must (1) be persisted before anyone refreshes again and
 * (2) never run twice concurrently against the same chain. A
 * CodexTokenStore gives (1); codexAuthSource's in-process mutex gives (2)
 * for everything sharing one source — which is why the Worker routes every
 * caller through ONE Durable Object, and the laptop through the CLI's own
 * auth.json (the same file `codex` itself rotates in place).
 *
 * Without a persistent store there is no safe refresh, so the fallback
 * source only ever uses a static CODEX_ACCESS_TOKEN and says so when it
 * expires, rather than burning a refresh token it cannot remember.
 */

/** The Codex CLI's public OAuth client (PKCE, no secret) — the login these tokens come from. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Refresh this long before `exp`, so a token never expires mid-request. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export interface CodexTokens {
  accessToken?: string;
  refreshToken: string;
  idToken?: string;
  accountId?: string;
  /**
   * The env refresh token this chain was seeded from. When the operator
   * re-seeds (new login → new secret), the stored chain is abandoned for the
   * new one instead of being refreshed forever from a dead login.
   */
  seededFrom?: string;
}

export interface CodexTokenStore {
  load(): Promise<CodexTokens | undefined>;
  save(tokens: CodexTokens): Promise<void>;
}

/** What a request needs: the bearer and the ChatGPT account it acts for. */
export interface CodexAuth {
  accessToken: string;
  accountId?: string;
}

/** `force` = the backend just 401'd this token; refresh even if `exp` says it is fine. */
export type CodexAuthSource = (opts?: { force?: boolean }) => Promise<CodexAuth>;

export function memoryTokenStore(initial?: CodexTokens): CodexTokenStore {
  let tokens = initial;
  return {
    load: async () => tokens,
    save: async (t) => {
      tokens = t;
    },
  };
}

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

function fresh(accessToken: string | undefined, now: number): accessToken is string {
  const exp = jwtClaims(accessToken)?.exp;
  return typeof exp === "number" && exp * 1000 - EXPIRY_SKEW_MS > now;
}

export interface CodexAuthOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Seed from CODEX_REFRESH_TOKEN (default true). The laptop's auth.json
   * source turns this OFF: the env token is the WORKER's dedicated login,
   * and writing it into the CLI's file would put two owners on one chain.
   */
  seedFromEnv?: boolean;
}

/**
 * A serialized, persisting token source over `store`. Seeds from
 * CODEX_REFRESH_TOKEN (+ optional CODEX_ACCESS_TOKEN / CODEX_ACCOUNT_ID)
 * when the store is empty or the operator has re-seeded.
 */
export function codexAuthSource(store: CodexTokenStore, opts: CodexAuthOptions = {}): CodexAuthSource {
  const env = opts.env ?? {};
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = opts.now ?? Date.now;
  let chain: Promise<unknown> = Promise.resolve();

  const step = async (force: boolean): Promise<CodexAuth> => {
    const seed = opts.seedFromEnv === false ? undefined : getEnv(env, "CODEX_REFRESH_TOKEN");
    let tokens = await store.load();
    if (seed && (!tokens || (tokens.seededFrom !== undefined && tokens.seededFrom !== seed))) {
      tokens = {
        refreshToken: seed,
        seededFrom: seed,
        accessToken: getEnv(env, "CODEX_ACCESS_TOKEN"),
        accountId: getEnv(env, "CODEX_ACCOUNT_ID"),
      };
      await store.save(tokens);
    }
    if (!tokens) {
      throw new Error(
        "codex-api: no Codex login — set CODEX_REFRESH_TOKEN from a DEDICATED `codex login` (see docs/deploying-cloud.md), or log in with the codex CLI on this machine",
      );
    }
    const accountId = () => tokens!.accountId ?? accountIdFrom(tokens!.idToken, tokens!.accessToken);
    if (!force && fresh(tokens.accessToken, now())) {
      return { accessToken: tokens.accessToken, accountId: accountId() };
    }

    const res = await doFetch(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: CODEX_CLIENT_ID,
        scope: "openid profile email",
      }).toString(),
    });
    if (!res.ok) {
      const raw = (await res.text().catch(() => "")).slice(0, 200);
      const reused = /refresh_token_reused|invalid_grant/i.test(raw);
      throw new Error(
        `codex-api → token refresh HTTP ${res.status}: ${raw}` +
          (reused
            ? " [the refresh token was already spent or revoked — something else refreshed this login. Give the Worker its OWN `codex login` and re-seed CODEX_REFRESH_TOKEN]"
            : ""),
      );
    }
    const json = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
    if (!json.access_token) throw new Error("codex-api → token refresh returned no access_token");
    // Persist BEFORE use: the old refresh token is already spent server-side.
    tokens = {
      ...tokens,
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? tokens.refreshToken,
      idToken: json.id_token ?? tokens.idToken,
    };
    tokens.accountId = accountIdFrom(tokens.idToken, tokens.accessToken) ?? tokens.accountId;
    await store.save(tokens);
    return { accessToken: json.access_token, accountId: tokens.accountId };
  };

  return (o = {}) => {
    const next = chain.then(() => step(o.force ?? false));
    chain = next.catch(() => {});
    return next;
  };
}

/**
 * The no-store fallback: a static CODEX_ACCESS_TOKEN, never refreshed
 * (refreshing without persistence would spend the refresh token and forget
 * its replacement). Tells the operator exactly that when it runs out.
 */
export function staticCodexAuth(opts: CodexAuthOptions = {}): CodexAuthSource {
  const env = opts.env ?? {};
  const now = opts.now ?? Date.now;
  return async ({ force } = {}) => {
    const accessToken = getEnv(env, "CODEX_ACCESS_TOKEN");
    if (!accessToken || force || !fresh(accessToken, now())) {
      throw new Error(
        "codex-api: no usable access token and no persistent token store to refresh with — run from the Worker (Durable-Object-backed) or a laptop with `codex login` (auth.json)",
      );
    }
    return { accessToken, accountId: getEnv(env, "CODEX_ACCOUNT_ID") ?? accountIdFrom(accessToken) };
  };
}
