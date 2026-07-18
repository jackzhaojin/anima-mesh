import { getEnv } from "./env-core.js";

/**
 * GitHub auth for the remote instance store, isolated in one module so auth
 * strategy changes never touch call sites.
 *
 * v2 — GitHub App installation tokens (the PAT's replacement):
 *   Set GITHUB_APP_ID + GITHUB_APP_INSTALLATION_ID + GITHUB_APP_PRIVATE_KEY
 *   (PKCS#8 PEM). The module signs a short-lived RS256 JWT with WebCrypto,
 *   exchanges it at POST /app/installations/{id}/access_tokens, and caches
 *   the ~1h token until 5 minutes before expiry.
 * v1 — fine-grained PAT in GITHUB_TOKEN (contents-only, single repo): still
 *   supported, used only when NO App var is set. A partial App config fails
 *   loudly rather than falling back — a silent fallback would mask App
 *   breakage until the day the PAT expires.
 *
 * Workers-safe: no node built-ins; pure fetch + WebCrypto.
 */

const APP_VARS = ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"] as const;

/** `CryptoKey` without naming it — the engine's tsconfig carries no DOM lib. */
type SubtleKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** Keyed by `${appId}:${installationId}`; isolate-lifetime, ~1 mint per beat. */
const tokenCache = new Map<string, CachedToken>();

/** Test hook: installation tokens must not leak across test cases. */
export function clearGithubTokenCache(): void {
  tokenCache.clear();
}

export async function githubToken(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const [appId, installationId, privateKey] = APP_VARS.map((k) => getEnv(env, k));

  if (appId || installationId || privateKey) {
    if (!appId || !installationId || !privateKey) {
      const missing = APP_VARS.filter((k) => !getEnv(env, k)).join(", ");
      throw new Error(`github store: partial GitHub App config — missing ${missing} (set all three, or none to use a PAT)`);
    }
    return installationToken(appId, installationId, privateKey, fetchImpl);
  }

  const token = getEnv(env, "GITHUB_TOKEN");
  if (!token) {
    throw new Error(
      "github store: no auth — set the GitHub App trio (GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY) " +
        "or a fine-grained PAT with Contents read/write in GITHUB_TOKEN",
    );
  }
  return token;
}

async function installationToken(
  appId: string,
  installationId: string,
  privateKeyPem: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const cacheKey = `${appId}:${installationId}`;
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);
  if (cached && now < cached.expiresAtMs - 5 * 60_000) return cached.token;

  const key = await importPkcs8(privateKeyPem);
  const jwt = await signAppJwt(appId, key, now);

  const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      // UA-less GitHub calls 403 from Workers (learning 2026-07-18).
      "user-agent": "animamesh-engine",
    },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`github store: App installation token mint failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { token?: string; expires_at?: string };
  if (!json.token) {
    throw new Error("github store: App installation token response had no token field");
  }
  const expiresAtMs = json.expires_at ? Date.parse(json.expires_at) : now + 55 * 60_000;
  tokenCache.set(cacheKey, { token: json.token, expiresAtMs });
  // Operational proof of WHICH auth path served a run (`wrangler tail`).
  console.log(`github auth: App installation token minted (app ${appId})`);
  return json.token;
}

/**
 * GitHub downloads App keys as PKCS#1 ("BEGIN RSA PRIVATE KEY") but WebCrypto
 * imports only PKCS#8 — detect and say exactly how to convert, in the error.
 */
async function importPkcs8(pem: string): Promise<SubtleKey> {
  // Tolerate keys that arrived with literal "\n" escapes (a common paste-based
  // secret-loading mistake; piping the file avoids it entirely).
  const normalized = pem.replaceAll("\\n", "\n").trim();
  if (normalized.includes("RSA PRIVATE KEY")) {
    throw new Error(
      "github store: GITHUB_APP_PRIVATE_KEY is PKCS#1 (\"BEGIN RSA PRIVATE KEY\") — GitHub downloads keys in that " +
        "format but WebCrypto imports only PKCS#8. Convert once: openssl pkcs8 -topk8 -nocrypt -in <downloaded>.pem -out app.pem",
    );
  }
  const b64 = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  if (!b64) throw new Error("github store: GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("github store: GITHUB_APP_PRIVATE_KEY PEM body is not valid base64");
  }
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** ≤10-minute App JWT: proves "I am this App", nothing more. */
async function signAppJwt(appId: string, key: SubtleKey, nowMs: number): Promise<string> {
  const nowS = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat backdated 60s against clock skew; exp 9min (GitHub's cap is 10).
  const payload = b64url(JSON.stringify({ iat: nowS - 60, exp: nowS + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${b64url(sig)}`;
}

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
