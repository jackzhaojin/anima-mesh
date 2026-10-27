import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { loadInstanceEnv } from "../instance/env.js";
import { GOOGLE_READ_SCOPES } from "../sources/google.js";
import { assertNotLocal } from "../instance/local-mode.js";
import type { InstanceConfig } from "../instance/config-core.js";

/**
 * `anima-mesh connect google` - the one-time consent that lets a brain READ
 * its principal's Gmail, Calendar, and Drive (Node-only, laptop act).
 *
 * The OAuth "installed app" flow with PKCE and a loopback redirect: a
 * one-shot server on 127.0.0.1 receives the code, the code is exchanged for
 * a refresh token, and the token is written straight into the instance's
 * `.env.local` (mode 600) - never printed, never logged, never committed.
 * Scopes are fixed to gmail.readonly + calendar.readonly + drive.readonly;
 * there is no flag to widen them. Re-running it after the scope list grows
 * replaces the one refresh token with one that carries every scope.
 *
 * Prerequisite (the principal's act, in Google Cloud Console): an OAuth
 * client of type "Desktop app" in a project whose consent screen is In
 * Production (Testing-mode refresh tokens die after 7 days) and the Gmail,
 * Calendar, and Drive APIs enabled, with
 * GOOGLE_READ_CLIENT_ID and GOOGLE_READ_CLIENT_SECRET placed in the
 * instance's .env.local.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface ConsentUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** Pre-select the account (the principal's address) in Google's chooser. */
  loginHint?: string;
}

export function buildConsentUrl(input: ConsentUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_READ_SCOPES.join(" "),
    access_type: "offline",
    // Always re-prompt: without consent, Google may omit the refresh token.
    prompt: "consent",
    include_granted_scopes: "false",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface TokenExchange {
  refreshToken: string;
  scopes: string[];
  accessToken: string;
}

export async function exchangeCode(
  input: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string },
  fetchImpl: typeof fetch = (i, init) => fetch(i, init),
): Promise<TokenExchange> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      code_verifier: input.verifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as {
    refresh_token?: string;
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`token exchange failed: HTTP ${res.status} ${json.error ?? ""} ${json.error_description ?? ""}`.trim());
  }
  if (!json.refresh_token) {
    throw new Error("Google returned no refresh token - revoke the app at myaccount.google.com/permissions and run connect again");
  }
  const scopes = (json.scope ?? "").split(/\s+/).filter(Boolean);
  // Least privilege holds only if Google granted exactly what was asked.
  const extra = scopes.filter((s) => !(GOOGLE_READ_SCOPES as readonly string[]).includes(s) && s !== "openid");
  if (extra.length > 0) throw new Error(`refusing a token with scopes beyond read-only: ${extra.join(", ")}`);
  return { refreshToken: json.refresh_token, scopes, accessToken: json.access_token };
}

/**
 * Set KEY=value in an env file: replace the existing line (first wins) or
 * append. The file ends up mode 600. The value is never echoed by callers.
 */
export function upsertEnvValue(file: string, key: string, value: string): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  const line = `${key}="${value}"`;
  if (idx >= 0) lines[idx] = line;
  else {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
  }
  writeFileSync(file, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
}

export interface ConnectGoogleOptions {
  instanceRoot: string;
  /** Loopback port; 0 picks a free one. */
  port?: number;
  /** Open the consent URL in the default browser (macOS `open`, else `xdg-open`). */
  openBrowser?: boolean;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Give up waiting for the browser after this long. */
  timeoutMs?: number;
}

export interface ConnectGoogleResult {
  account?: string;
  scopes: string[];
  /** Read scopes asked for but not granted (the principal unticked them on the consent screen). */
  missing: string[];
  envFile: string;
}

/** Run the full loopback consent; resolves once the refresh token is stored and verified. */
export async function connectGoogle(opts: ConnectGoogleOptions): Promise<ConnectGoogleResult> {
  const root = path.resolve(opts.instanceRoot);
  // A local-mode brain never connects a cloud account (v2.3.6).
  const mode = (JSON.parse(readFileSync(path.join(root, "animamesh.config.json"), "utf8")) as { mode?: string }).mode;
  if (mode === "local") assertNotLocal({ mode: "local" } as InstanceConfig, "connecting a Google account");
  const env = loadInstanceEnv(root);
  const clientId = env.GOOGLE_READ_CLIENT_ID;
  const clientSecret = env.GOOGLE_READ_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "connect google: put GOOGLE_READ_CLIENT_ID and GOOGLE_READ_CLIENT_SECRET (an OAuth client of type Desktop app) " +
        `in ${path.join(root, ".env.local")} first`,
    );
  }
  const config = JSON.parse(readFileSync(path.join(root, "animamesh.config.json"), "utf8")) as {
    identity?: { principal?: { email?: string } };
  };
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("hex");
  const doFetch = opts.fetchImpl ?? ((i, init) => fetch(i, init));

  const { server, port } = await listen(opts.port ?? 0);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const url = buildConsentUrl({ clientId, redirectUri, state, codeChallenge: challenge, loginHint: config.identity?.principal?.email });

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connect google: timed out waiting for the browser consent")), opts.timeoutMs ?? 5 * 60_000);
      server.on("request", (req, res) => {
        const reqUrl = new URL(req.url ?? "/", redirectUri);
        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const error = reqUrl.searchParams.get("error");
        const got = reqUrl.searchParams.get("code");
        if (reqUrl.searchParams.get("state") !== state) {
          res.writeHead(400, { "content-type": "text/plain" }).end("State mismatch - close this tab and run connect again.");
          clearTimeout(timer);
          reject(new Error("connect google: state mismatch (possible CSRF) - nothing stored"));
          return;
        }
        if (error || !got) {
          res.writeHead(400, { "content-type": "text/plain" }).end(`Consent not granted (${error ?? "no code"}). Nothing was stored.`);
          clearTimeout(timer);
          reject(new Error(`connect google: consent not granted (${error ?? "no code"})`));
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" }).end("Connected. You can close this tab and return to the terminal.");
        clearTimeout(timer);
        resolve(got);
      });
      opts.log("Open this URL to grant READ-ONLY Gmail + Calendar + Drive access (gmail.readonly, calendar.readonly, drive.readonly):");
      opts.log(`  ${url}`);
      if (opts.openBrowser) {
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        execFile(opener, [url], () => {
          /* best effort; the URL is printed either way */
        });
      }
    });

    const tokens = await exchangeCode({ clientId, clientSecret, code, verifier, redirectUri }, doFetch);
    const envFile = path.join(root, ".env.local");
    upsertEnvValue(envFile, "GOOGLE_READ_REFRESH_TOKEN", tokens.refreshToken);

    const missing = GOOGLE_READ_SCOPES.filter((s) => !tokens.scopes.includes(s));
    if (missing.length > 0) {
      opts.log(`warning: consent left out ${missing.join(", ")} - those sources will report a scope gap until connect is re-run`);
    }

    // Verify with the fresh access token: whose mailbox, and the calendar and drive answer.
    let account: string | undefined;
    const profile = await doFetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (profile.ok) account = ((await profile.json()) as { emailAddress?: string }).emailAddress;
    const cal = await doFetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const drive = await doFetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!profile.ok || !cal.ok || !drive.ok) {
      opts.log(
        `warning: stored the token, but verification answered gmail=${profile.status} calendar=${cal.status} drive=${drive.status}` +
          " (403 usually means that API is not enabled in the client's Cloud project)",
      );
    }
    return { account, scopes: tokens.scopes, missing, envFile };
  } finally {
    server.close();
  }
}

function listen(port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve({ server, port: address.port });
      else reject(new Error("connect google: could not bind a loopback port"));
    });
  });
}
