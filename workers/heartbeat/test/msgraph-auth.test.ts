import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, SELF, fetchMock, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/env.js";
import type { MsGraphCredential } from "../../../src/sources/msgraph-auth.js";
import { wipeHeartbeatDo } from "./fixtures.js";

beforeEach(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  await wipeHeartbeatDo();
});
afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
  fetchMock.deactivate();
});

describe("Graph credential broker in workerd", () => {
  it("persists rotation in DO storage and uses it after the in-memory manager is lost", async () => {
    const stub = env.HEARTBEAT_DO.get(env.HEARTBEAT_DO.idFromName("graph-rotation-test"));
    // A private test object with fake credentials; production env is unchanged.
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAll();
      Object.assign(instance, { graphToken: undefined, env: {
        ...env, MSGRAPH_CLIENT_ID: "test-client", MSGRAPH_REFRESH_TOKEN: "bootstrap",
      } satisfies Env });
    });
    const used: string[] = [];
    fetchMock.get("https://login.microsoftonline.com")
      .intercept({ method: "POST", path: "/common/oauth2/v2.0/token" })
      .reply(200, (req) => {
        used.push(new URLSearchParams(String(req.body)).get("refresh_token")!);
        return { access_token: "test-access", refresh_token: `renewed-${used.length}` };
      }).times(2);
    const first = await stub.fetch("https://do/msgraph-token", { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ token: "test-access" });
    await runInDurableObject(stub, (instance) => { Object.assign(instance, { graphToken: undefined }); });
    const second = await stub.fetch("https://do/msgraph-token", { method: "POST" });
    expect(second.status).toBe(200);
    expect(used).toEqual(["bootstrap", "renewed-1"]);
    const saved = await runInDurableObject(stub, (_instance, state) => state.storage.get<MsGraphCredential>("msgraph-credential"));
    expect(saved?.refreshToken).toBe("renewed-2");
    expect(saved?.bootstrapHash).not.toContain("bootstrap");
  });

  it("does not expose the internal credential route on the public Worker", async () => {
    const response = await SELF.fetch("https://worker.test/msgraph-token", {
      method: "POST", headers: { authorization: `Bearer ${env.BEAT_TRIGGER_TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});
