import type { Env } from "./env.js";

/**
 * In-Worker Google OIDC (decision Q1a) + stateless HMAC sessions (A4).
 *
 * The id_token is obtained by exchanging the code DIRECTLY with Google's
 * token endpoint over TLS — it arrives first-hand from the issuer, so
 * signature re-verification adds nothing; we validate iss/aud/exp/
 * email_verified and then the allowlist. Deny-by-default (A2); the
 * allowlist is instance data in WEB_ALLOWED_EMAILS (A3), re-checked on
 * EVERY request so removing an address revokes live sessions.
 */

const STATE_COOKIE = "am_state";
const SESSION_COOKIE = "am_session";
const STATE_TTL_S = 600;
const SESSION_TTL_S = 7 * 24 * 3600;
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

// ---- encoding + HMAC ---------------------------------------------------------

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(data: string): Uint8Array {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function sign(secret: string, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Constant-time verify via WebCrypto; returns the payload or null. */
async function verify(secret: string, signed: string): Promise<string | null> {
  const at = signed.lastIndexOf(".");
  if (at <= 0) return null;
  const payload = signed.slice(0, at);
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(signed.slice(at + 1)),
      enc.encode(payload),
    );
    return ok ? payload : null;
  } catch {
    return null;
  }
}

// ---- cookies -----------------------------------------------------------------

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

// ---- allowlist (A2/A3) -------------------------------------------------------

export function isAllowedEmail(env: Env, email: string): boolean {
  const allowed = (env.WEB_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.length > 0 && allowed.includes(email.toLowerCase());
}

// ---- the OIDC flow -----------------------------------------------------------

export async function loginRedirect(env: Env, origin: string): Promise<Response> {
  const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const state = await sign(env.SESSION_SECRET, `${nonce}:${Math.floor(Date.now() / 1000) + STATE_TTL_S}`);
  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${origin}/auth/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), "Set-Cookie": cookie(STATE_COOKIE, state, STATE_TTL_S) },
  });
}

export type CallbackResult = { ok: true; response: Response } | { ok: false; status: number; reason: string };

export async function handleCallback(req: Request, env: Env, origin: string): Promise<CallbackResult> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateCookie = readCookie(req, STATE_COOKIE);
  if (!code || !state || !stateCookie || state !== stateCookie) {
    return { ok: false, status: 400, reason: "state mismatch" };
  }
  const statePayload = await verify(env.SESSION_SECRET, state);
  if (!statePayload || Number(statePayload.split(":")[1]) < Date.now() / 1000) {
    return { ok: false, status: 400, reason: "state invalid or expired" };
  }

  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: `${origin}/auth/callback`,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!tokenRes.ok) return { ok: false, status: 401, reason: `token exchange failed (${tokenRes.status})` };
  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  if (!id_token) return { ok: false, status: 401, reason: "no id_token" };

  // First-hand from the issuer over TLS — decode + validate claims.
  const parts = id_token.split(".");
  if (parts.length !== 3) return { ok: false, status: 401, reason: "malformed id_token" };
  let claims: { iss?: string; aud?: string; exp?: number; email?: string; email_verified?: boolean };
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]!)));
  } catch {
    return { ok: false, status: 401, reason: "malformed id_token payload" };
  }
  const issOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!issOk || claims.aud !== env.GOOGLE_OAUTH_CLIENT_ID || (claims.exp ?? 0) < Date.now() / 1000) {
    return { ok: false, status: 401, reason: "id_token claims rejected" };
  }
  if (!claims.email || claims.email_verified !== true) {
    return { ok: false, status: 401, reason: "email missing or unverified" };
  }
  if (!isAllowedEmail(env, claims.email)) {
    return { ok: false, status: 403, reason: "not on the allowlist" }; // deny-by-default (A2)
  }

  const session = await sign(
    env.SESSION_SECRET,
    b64urlEncode(enc.encode(JSON.stringify({ email: claims.email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }))),
  );
  return {
    ok: true,
    response: new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": [
          cookie(SESSION_COOKIE, session, SESSION_TTL_S),
          cookie(STATE_COOKIE, "", 0), // state is single-use
        ].join(", "),
      },
    }),
  };
}

/** The per-request gate: HMAC + expiry + a LIVE allowlist re-check. */
export async function sessionEmail(req: Request, env: Env): Promise<string | null> {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const payload = await verify(env.SESSION_SECRET, raw);
  if (!payload) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as { email: string; exp: number };
    if (session.exp < Date.now() / 1000) return null;
    if (!isAllowedEmail(env, session.email)) return null; // revocation = edit the var
    return session.email;
  } catch {
    return null;
  }
}

export function logout(): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": cookie(SESSION_COOKIE, "", 0) },
  });
}
