import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SELF, fetchMock } from "cloudflare:test";
import { mockGitHubReads, mockHealthz, mockBeatTrigger, mockGoogleToken, idToken } from "./fixtures.js";

/**
 * The web tier in real workerd: the OIDC door, the allowlist (A2/A3),
 * session integrity (A4), the dashboard's reads, and the one action (Q2) —
 * with the Bearer token proven to stay server-side.
 */

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors(); // the mock plan IS the expected traffic
  fetchMock.deactivate();
});

function cookieOf(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const [k, ...v] = pair!.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** The full login dance against a scripted Google; returns the session cookie. */
async function login(email = "principal@example.test"): Promise<string> {
  const start = await SELF.fetch("https://web.test/auth/login", { redirect: "manual" });
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = cookieOf(start, "am_state")!;

  mockGoogleToken(idToken({ email }));
  const cb = await SELF.fetch(
    `https://web.test/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `am_state=${stateCookie}` }, redirect: "manual" },
  );
  expect(cb.status).toBe(302);
  // Browser-real invariant (the Chrome comma lesson, 2026-07-12): cookies
  // must be SEPARATE Set-Cookie lines. A joined header parses in a real
  // browser as one cookie whose trailing Max-Age=0 expires the session.
  const setCookies = cb.headers.getSetCookie?.() ?? [];
  expect(setCookies).toHaveLength(2);
  for (const line of setCookies) expect(line).not.toContain(",");
  const sessionLine = setCookies.find((l) => l.startsWith("am_session="))!;
  expect(sessionLine).toContain("Max-Age=604800");
  const session = cookieOf(cb, "am_session");
  expect(session).not.toBeNull();
  return session!;
}

describe("the door", () => {
  it("unauthenticated / is a login page — zero data, zero coordinates", async () => {
    const res = await SELF.fetch("https://web.test/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in with Google");
    expect(html).not.toContain("owner/brain"); // no repo coordinates
    expect(html).not.toContain("brief");
  });

  it("/auth/login redirects to Google with client id, callback, and signed state", async () => {
    const res = await SELF.fetch("https://web.test/auth/login", { redirect: "manual" });
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location")!);
    expect(target.origin).toBe("https://accounts.google.com");
    expect(target.searchParams.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
    expect(target.searchParams.get("redirect_uri")).toBe("https://web.test/auth/callback");
    expect(target.searchParams.get("scope")).toBe("openid email");
    expect(cookieOf(res, "am_state")).toBe(target.searchParams.get("state"));
  });

  it("a wrong Google account gets 403 and NO session (deny-by-default, A2)", async () => {
    const start = await SELF.fetch("https://web.test/auth/login", { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    mockGoogleToken(idToken({ email: "intruder@example.test" }));
    const cb = await SELF.fetch(
      `https://web.test/auth/callback?code=x&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `am_state=${cookieOf(start, "am_state")}` }, redirect: "manual" },
    );
    expect(cb.status).toBe(403);
    expect(cookieOf(cb, "am_session")).toBeNull();
  });

  it("an unverified email is rejected even when allowlisted", async () => {
    const start = await SELF.fetch("https://web.test/auth/login", { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    mockGoogleToken(idToken({ email: "principal@example.test", email_verified: false }));
    const cb = await SELF.fetch(
      `https://web.test/auth/callback?code=x&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `am_state=${cookieOf(start, "am_state")}` }, redirect: "manual" },
    );
    expect(cb.status).toBe(401);
  });

  it("callback without the matching state cookie is rejected (CSRF)", async () => {
    const res = await SELF.fetch("https://web.test/auth/callback?code=x&state=whatever", {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });

  it("a forged session cookie is a stranger", async () => {
    const res = await SELF.fetch("https://web.test/", {
      headers: { cookie: "am_session=eyJmYWtlIjoxfQ.deadbeef" },
    });
    expect(await res.text()).toContain("Sign in with Google");
  });

  it("a tampered-payload session (valid shape, wrong signature) is a stranger", async () => {
    const session = await login();
    const [payload] = session.split(".");
    const res = await SELF.fetch("https://web.test/", {
      headers: { cookie: `am_session=${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` },
    });
    expect(await res.text()).toContain("Sign in with Google");
  });
});

describe("the dashboard (Q2: view)", () => {
  it("renders the mesh's state for a logged-in principal", async () => {
    const session = await login();
    mockGitHubReads();
    mockHealthz();

    const res = await SELF.fetch("https://web.test/", { headers: { cookie: `am_session=${session}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();

    expect(html).toContain("Test Mesh Ops"); // DASHBOARD_TITLE
    expect(html).toContain("principal@example.test"); // who's signed in
    expect(html).toContain("OK"); // last beat state
    expect(html).toContain("2026-07-12T12:00:00.000Z"); // next alarm
    expect(html).toContain("All quiet; runway is fine."); // the latest BRIEF...
    expect(html).toContain("The daily brief");
    expect(html).toContain("file the annual return"); // pending approval
    expect(html).toContain("direction-completed"); // ledger tail
    expect(html).toContain("beat(cloud): 2026-07-11"); // recent commits
    expect(html).toContain("Trigger a beat now"); // the one action
    expect(html).not.toContain("test-beat-token"); // the Bearer never renders
  });

  it("the latest brief is never a direction artifact (the dot-name contract)", async () => {
    const session = await login();
    mockGitHubReads();
    mockHealthz();
    const res = await SELF.fetch("https://web.test/", { headers: { cookie: `am_session=${session}` } });
    const html = await res.text();
    // The direction artifact is newer but must not render as "Latest brief".
    expect(html).toContain("2026-07-10-chief-of-staff-run0aaaa.md");
    expect(html.indexOf("Latest brief")).toBeGreaterThan(-1);
    expect(html).not.toContain("secret question"); // direction body not inlined as the brief
  });

  it("the latest brief is never reports/README.md (only date-stamped artifacts qualify)", async () => {
    const session = await login();
    mockGitHubReads();
    mockHealthz();
    const res = await SELF.fetch("https://web.test/", { headers: { cookie: `am_session=${session}` } });
    const html = await res.text();
    // README.md sorts after every "2026-…" name; it stole the panel live on
    // first dashboard login (2026-07-12). The real brief must win.
    expect(html).toContain("All quiet; runway is fine.");
    expect(html).not.toContain("NOT a brief");
  });
});

describe("the one action (Q2: trigger-beat)", () => {
  it("proxies POST /actions/beat with the server-held Bearer token", async () => {
    const session = await login();
    const beat = mockBeatTrigger();
    const res = await SELF.fetch("https://web.test/actions/beat", {
      method: "POST",
      headers: { cookie: `am_session=${session}`, origin: "https://web.test" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Beat triggered");
    expect(beat.auth).toEqual(["Bearer test-beat-token"]);
  });

  it("no session → 401; cross-origin → 403 (CSRF posture)", async () => {
    const bare = await SELF.fetch("https://web.test/actions/beat", { method: "POST" });
    expect(bare.status).toBe(401);

    const session = await login();
    const crossOrigin = await SELF.fetch("https://web.test/actions/beat", {
      method: "POST",
      headers: { cookie: `am_session=${session}`, origin: "https://evil.test" },
    });
    expect(crossOrigin.status).toBe(403);
  });
});

describe("logout", () => {
  it("clears the session", async () => {
    const session = await login();
    const out = await SELF.fetch("https://web.test/logout", {
      headers: { cookie: `am_session=${session}` },
      redirect: "manual",
    });
    expect(out.status).toBe(302);
    const cleared = (out.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("am_session="));
    expect(cleared).toContain("Max-Age=0");
  });
});
