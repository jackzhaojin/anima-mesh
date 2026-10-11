import { describe, it, expect, afterEach, vi } from "vitest";
import { rm, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { makeTree } from "./helpers.js";
import { buildConsentUrl, exchangeCode, pkcePair, upsertEnvValue, connectGoogle } from "../src/connect/google.js";
import { loadInstanceEnv } from "../src/instance/env.js";

/**
 * `anima-mesh connect google`: the consent asks for read-only scopes and
 * nothing else; a token with wider scopes is refused; the refresh token
 * goes to .env.local (mode 600) and is never printed.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("consent URL", () => {
  it("asks for exactly the read-only scopes, offline, with PKCE S256", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const url = new URL(buildConsentUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555/callback", state: "st", codeChallenge: challenge, loginHint: "p@example.test" }));
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("login_hint")).toBe("p@example.test");
  });
});

describe("token exchange", () => {
  const input = { clientId: "c", clientSecret: "s", code: "code", verifier: "v", redirectUri: "http://127.0.0.1:1/callback" };

  it("refuses a token carrying any scope beyond read-only", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ access_token: "a", refresh_token: "r", scope: "https://www.googleapis.com/auth/gmail.readonly https://mail.google.com/" }),
    );
    await expect(exchangeCode(input, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/beyond read-only: https:\/\/mail\.google\.com\//);
  });

  it("requires a refresh token", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "a", scope: "https://www.googleapis.com/auth/gmail.readonly" }));
    await expect(exchangeCode(input, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/no refresh token/);
  });
});

describe("env upsert", () => {
  it("replaces or appends, and leaves the file mode 600", async () => {
    const root = await makeTree({ ".env.local": 'A="1"\nGOOGLE_READ_REFRESH_TOKEN="old"\nB=2\n' });
    roots.push(root);
    const file = path.join(root, ".env.local");
    upsertEnvValue(file, "GOOGLE_READ_REFRESH_TOKEN", "new-token");
    upsertEnvValue(file, "C", "3");
    const env = loadInstanceEnv(root);
    expect(env).toMatchObject({ A: "1", B: "2", C: "3", GOOGLE_READ_REFRESH_TOKEN: "new-token" });
    expect((await readFile(file, "utf8")).match(/GOOGLE_READ_REFRESH_TOKEN/g)).toHaveLength(1);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("the loopback flow end to end", () => {
  it("stores the refresh token without printing it, and verifies the account", async () => {
    const root = await makeTree({
      "animamesh.config.json": JSON.stringify({ bundle: "bundle", identity: { principal: { name: "P", email: "p@example.test" } } }),
      ".env.local": 'GOOGLE_READ_CLIENT_ID="cid"\nGOOGLE_READ_CLIENT_SECRET="csecret"\n',
    });
    roots.push(root);
    const logs: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return Response.json({
          access_token: "fresh-access",
          refresh_token: "SECRET-REFRESH-VALUE",
          scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
        });
      }
      if (url.includes("/gmail/v1/users/me/profile")) return Response.json({ emailAddress: "p@example.test" });
      if (url.includes("/calendarList")) return Response.json({ items: [] });
      if (url.includes("/drive/v3/about")) return Response.json({ user: { emailAddress: "p@example.test" } });
      return new Response("nope", { status: 404 });
    });
    let browser: Promise<Response> | undefined;
    const done = connectGoogle({
      instanceRoot: root,
      openBrowser: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10_000,
      log: (line) => {
        logs.push(line);
        const m = line.match(/https:\/\/accounts\.google\.com\S+/);
        if (m) {
          // Play the browser: Google redirects back with a code and the state.
          const consent = new URL(m[0]);
          const callback = new URL(consent.searchParams.get("redirect_uri")!);
          callback.searchParams.set("code", "auth-code");
          callback.searchParams.set("state", consent.searchParams.get("state")!);
          browser = fetch(callback.toString());
        }
      },
    });
    const result = await done;
    expect((await browser!).status).toBe(200);
    expect(result.account).toBe("p@example.test");
    expect(loadInstanceEnv(root).GOOGLE_READ_REFRESH_TOKEN).toBe("SECRET-REFRESH-VALUE");
    expect(logs.join("\n")).not.toContain("SECRET-REFRESH-VALUE");
    // the principal unticked Drive on the consent screen: stored, but said out loud
    expect(result.missing).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
    expect(logs.join("\n")).toMatch(/consent left out https:\/\/www\.googleapis\.com\/auth\/drive\.readonly/);
  });

  it("a forged callback (wrong state) stores nothing", async () => {
    const root = await makeTree({
      "animamesh.config.json": JSON.stringify({ bundle: "bundle" }),
      ".env.local": 'GOOGLE_READ_CLIENT_ID="cid"\nGOOGLE_READ_CLIENT_SECRET="csecret"\n',
    });
    roots.push(root);
    const done = connectGoogle({
      instanceRoot: root,
      openBrowser: false,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      timeoutMs: 10_000,
      log: (line) => {
        const m = line.match(/https:\/\/accounts\.google\.com\S+/);
        if (m) {
          const callback = new URL(new URL(m[0]).searchParams.get("redirect_uri")!);
          callback.searchParams.set("code", "x");
          callback.searchParams.set("state", "forged");
          void fetch(callback.toString());
        }
      },
    });
    await expect(done).rejects.toThrow(/state mismatch/);
    expect(loadInstanceEnv(root).GOOGLE_READ_REFRESH_TOKEN).toBeUndefined();
  });

  it("refuses to start without the client id/secret", async () => {
    const root = await makeTree({ "animamesh.config.json": JSON.stringify({ bundle: "bundle" }) });
    roots.push(root);
    await writeFile(path.join(root, ".env.local"), "");
    await expect(connectGoogle({ instanceRoot: root, log: () => {} })).rejects.toThrow(/GOOGLE_READ_CLIENT_ID and GOOGLE_READ_CLIENT_SECRET/);
  });
});
