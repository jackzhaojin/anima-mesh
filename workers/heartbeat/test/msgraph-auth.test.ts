import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, SELF, fetchMock, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/env.js";
import type { MsGraphCredential } from "../../../src/sources/msgraph-auth.js";
import { wipeHeartbeatDo, brainFiles, mockGitHub, mockKimi, mockDiscord, settledLastBeat } from "./fixtures.js";

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
  it("serves Graph context during the same object's manual alarm beat", async () => {
    const stub = env.HEARTBEAT_DO.get(env.HEARTBEAT_DO.idFromName("main"));
    const files = brainFiles();
    files["bundle/agents/chief-of-staff.md"] = files["bundle/agents/chief-of-staff.md"]!
      .replace("type: agent", "type: agent\ncontext-sources: [onedrive]");
    mockGitHub({ files }); const kimi = mockKimi(); mockDiscord();
    fetchMock.get("https://login.microsoftonline.com")
      .intercept({ method: "POST", path: "/common/oauth2/v2.0/token" })
      .reply(200, { access_token: "test-access", refresh_token: "rotated", expires_in: 3600 });
    const graph = fetchMock.get("https://graph.microsoft.com");
    graph.intercept({ method: "GET", path: /\/v1\.0\/me\/drive\/root\?/ })
      .reply(200, { id: "root", name: "root", folder: {}, parentReference: { driveId: "test-drive" } });
    graph.intercept({ method: "GET", path: /\/v1\.0\/drives\/test-drive\/items\/root\/children\?/ })
      .reply(200, { value: [] });
    await runInDurableObject(stub, (instance) => {
      Object.assign(instance, { env: { ...env, MSGRAPH_CLIENT_ID: "test-client", MSGRAPH_REFRESH_TOKEN: "bootstrap" } });
    });
    try {
      await SELF.fetch("https://worker.test/beat", { method: "POST", headers: { authorization: `Bearer ${env.BEAT_TRIGGER_TOKEN}` } });
      const last = await settledLastBeat<{ summary: { ran: number; failures: unknown[] } }>();
      expect(last?.summary.ran).toBe(1);
      expect(last?.summary.failures).toEqual([]);
      expect(JSON.stringify(kimi.requests)).not.toContain("source unavailable");
      const saved = await runInDurableObject(stub, (_i, state) => state.storage.get<MsGraphCredential>("msgraph-credential"));
      expect(saved?.refreshToken).toBe("rotated");
    } finally {
      await runInDurableObject(stub, (instance) => { Object.assign(instance, { env, graphToken: undefined }); });
    }
  });

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
