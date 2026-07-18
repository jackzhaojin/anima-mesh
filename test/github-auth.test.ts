import { describe, it, expect, beforeEach, vi } from "vitest";
import { githubToken, clearGithubTokenCache } from "../src/instance/github-auth.js";

/**
 * The App-token mint, proven without GitHub: a real RSA keypair generated
 * in-test signs the JWT, the injected fetch plays the installation-token
 * endpoint, and the JWT is verified against the public half — the same
 * cryptography Workers run in production, minus the network.
 */

const APP_ENV = () => ({
  GITHUB_APP_ID: "4242",
  GITHUB_APP_INSTALLATION_ID: "999",
  GITHUB_APP_PRIVATE_KEY: pem,
});

type SubtleKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

let pem: string;
let publicKey: SubtleKey;

beforeEach(async () => {
  clearGithubTokenCache();
  // getEnv falls back to process.env — a CI runner's ambient GITHUB_TOKEN
  // must not turn the "no auth" case into a PAT case.
  for (const k of ["GITHUB_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"]) {
    vi.stubEnv(k, "");
  }
  if (!pem) {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as { publicKey: SubtleKey; privateKey: SubtleKey };
    publicKey = pair.publicKey;
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    let bin = "";
    for (const b of der) bin += String.fromCharCode(b);
    pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  }
});

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function mintFetch(capture: Captured[], status = 201, body?: unknown): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    capture.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    if (status >= 400) return new Response("nope", { status });
    return Response.json(body ?? { token: "ghs_minted", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status });
  }) as typeof fetch;
}

describe("githubToken — PAT path", () => {
  it("returns the PAT when no App var is set, without any network call", async () => {
    const calls: Captured[] = [];
    const token = await githubToken({ GITHUB_TOKEN: "pat-123" }, mintFetch(calls));
    expect(token).toBe("pat-123");
    expect(calls).toHaveLength(0);
  });

  it("no auth at all → error naming both options", async () => {
    await expect(githubToken({}, mintFetch([]))).rejects.toThrow(/GitHub App trio.*|GITHUB_TOKEN/);
  });
});

describe("githubToken — App path", () => {
  it("mints an installation token with a verifiable RS256 JWT and a User-Agent", async () => {
    const calls: Captured[] = [];
    const token = await githubToken(APP_ENV(), mintFetch(calls));
    expect(token).toBe("ghs_minted");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/app/installations/999/access_tokens");
    // UA-less GitHub calls 403 from Workers — the header must always be sent.
    expect(calls[0]!.headers["user-agent"]).toBeTruthy();
    expect(calls[0]!.headers.accept).toBe("application/vnd.github+json");

    const jwt = calls[0]!.headers.authorization!.replace("Bearer ", "");
    const [h, p, s] = jwt.split(".");
    const fromB64url = (x: string) => Uint8Array.from(atob(x.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h!)))).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(p!))) as { iss: string; iat: number; exp: number };
    expect(payload.iss).toBe("4242");
    expect(payload.exp - payload.iat).toBe(600); // 60s backdate + 9min life ≤ GitHub's 10min cap

    // The signature verifies against the public half — real crypto, no mocks.
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      fromB64url(s!),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it("caches the installation token until near expiry — one mint, many calls", async () => {
    const calls: Captured[] = [];
    const fetchImpl = mintFetch(calls);
    await githubToken(APP_ENV(), fetchImpl);
    const again = await githubToken(APP_ENV(), fetchImpl);
    expect(again).toBe("ghs_minted");
    expect(calls).toHaveLength(1);
  });

  it("App vars take precedence over a PAT that is also present", async () => {
    const calls: Captured[] = [];
    const token = await githubToken({ ...APP_ENV(), GITHUB_TOKEN: "pat-should-lose" }, mintFetch(calls));
    expect(token).toBe("ghs_minted");
    expect(calls).toHaveLength(1);
  });

  it("partial App config fails loudly — never a silent PAT fallback", async () => {
    await expect(
      githubToken({ GITHUB_APP_ID: "4242", GITHUB_TOKEN: "pat" }, mintFetch([])),
    ).rejects.toThrow(/partial GitHub App config.*GITHUB_APP_INSTALLATION_ID/);
  });

  it("a PKCS#1 key throws the exact conversion hint", async () => {
    const env = { ...APP_ENV(), GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----" };
    await expect(githubToken(env, mintFetch([]))).rejects.toThrow(/openssl pkcs8 -topk8 -nocrypt/);
  });

  it("a failed mint surfaces the status", async () => {
    await expect(githubToken(APP_ENV(), mintFetch([], 401))).rejects.toThrow(/mint failed \(401\)/);
  });
});
