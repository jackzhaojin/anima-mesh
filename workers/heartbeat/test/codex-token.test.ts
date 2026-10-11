import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { wipeHeartbeatDo } from "./fixtures.js";
import { remoteCodexAuth } from "../src/codex-token.js";
import type { Env } from "../src/env.js";

/**
 * The Codex login has exactly ONE owner in the Worker: HeartbeatDO. Its
 * refresh tokens rotate, so a refresh anywhere else would spend a token the
 * owner still holds. These run in real workerd against real DO storage.
 */
const e = env as unknown as Env;
const stub = () => e.HEARTBEAT_DO.get(e.HEARTBEAT_DO.idFromName("main"));

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}
const freshAccess = jwt({
  exp: Math.floor(Date.now() / 1000) + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-worker" },
});

beforeEach(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  await wipeHeartbeatDo();
});
afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
  fetchMock.deactivate();
});

describe("HeartbeatDO as the single Codex token owner", () => {
  it("seeds from the secret, refreshes once, persists the rotation, and reuses the fresh token", async () => {
    let refreshBody = "";
    fetchMock
      .get("https://auth.openai.com")
      .intercept({ path: "/oauth/token", method: "POST" })
      .reply(200, (opts) => {
        refreshBody = String(opts.body);
        return JSON.stringify({ access_token: freshAccess, refresh_token: "rt-rotated" });
      });

    // DirectionDO's path: through the owner, never its own refresh.
    const first = await remoteCodexAuth(e)();
    expect(first).toEqual({ accessToken: freshAccess, accountId: "acct-worker" });
    expect(new URLSearchParams(refreshBody).get("refresh_token")).toBe("test-codex-refresh-not-real");

    const stored = await runInDurableObject(stub(), (_i, state) =>
      state.storage.get<{ refreshToken: string; seededFrom: string }>("codex-tokens"),
    );
    expect(stored?.refreshToken).toBe("rt-rotated");
    expect(stored?.seededFrom).toBe("test-codex-refresh-not-real");

    // Fresh token: no second refresh (no interceptor left to serve one).
    expect((await remoteCodexAuth(e)()).accessToken).toBe(freshAccess);
  });

  it("a refresh failure comes back as a named error, and the stored chain is untouched", async () => {
    fetchMock
      .get("https://auth.openai.com")
      .intercept({ path: "/oauth/token", method: "POST" })
      .reply(400, '{"error":"invalid_grant","error_description":"refresh_token_reused"}');

    await expect(remoteCodexAuth(e)()).rejects.toThrow(/already spent or revoked/);
    const stored = await runInDurableObject(stub(), (_i, state) =>
      state.storage.get<{ refreshToken: string }>("codex-tokens"),
    );
    expect(stored?.refreshToken).toBe("test-codex-refresh-not-real");
  });

  it("is not reachable from the public router", async () => {
    const { SELF } = await import("cloudflare:test");
    // The router only ever forwards fixed internal paths to the DO.
    const res = await SELF.fetch("https://worker.test/codex-token", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
