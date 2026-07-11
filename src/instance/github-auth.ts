import { getEnv } from "./env-core.js";

/**
 * GitHub auth for the remote instance store, isolated in one module so the
 * PAT → GitHub App swap is a one-file change (App: sign an RS256 JWT with
 * WebCrypto — keys must be converted PKCS#1→PKCS#8 first — then exchange it
 * at POST /app/installations/{id}/access_tokens and cache ~55 min).
 *
 * v1: a fine-grained PAT in GITHUB_TOKEN (contents-only, single repo).
 * Workers-safe: no node built-ins.
 */
export async function githubToken(env: Record<string, string | undefined>): Promise<string> {
  const token = getEnv(env, "GITHUB_TOKEN");
  if (!token) {
    throw new Error(
      "github store: GITHUB_TOKEN is not set — fine-grained PAT with Contents read/write on the brain repo",
    );
  }
  return token;
}
