import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createMsGraphTokenManager, type MsGraphCredential } from "../src/sources/msgraph-auth.js";
import { localMsGraphTokenManager } from "../src/sources/msgraph-auth-file.js";
import { msGraphAccessToken } from "../src/sources/msgraph.js";
import { nodeSourceFs } from "../src/sources/local-files.js";

const env = () => ({ MSGRAPH_CLIENT_ID: "test-client", MSGRAPH_REFRESH_TOKEN: "test-bootstrap" });
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function persistence() {
  let saved: MsGraphCredential | undefined;
  return { load: async () => saved, save: vi.fn(async (value: MsGraphCredential) => { saved = value; }) };
}

function endpoint() {
  const used: string[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    used.push(new URLSearchParams(String(init?.body)).get("refresh_token")!);
    return Response.json({ access_token: `access-${used.length}`, refresh_token: `rotated-${used.length}` });
  });
  return { used, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("Graph credential lifecycle", () => {
  it("persists each replacement before returning and resumes the chain after a runtime restart", async () => {
    const disk = persistence();
    const api = endpoint();
    const ctx = { env: env(), fetchImpl: api.fetchImpl };
    await expect(createMsGraphTokenManager(ctx, disk)()).resolves.toBe("access-1");
    const restarted = createMsGraphTokenManager(ctx, disk);
    await restarted();
    await restarted();
    expect(api.used).toEqual(["test-bootstrap", "rotated-1", "rotated-2"]);
    expect((await disk.load())?.refreshToken).toBe("rotated-3");
    expect(disk.save).toHaveBeenCalledTimes(3);
  });

  it("re-consent or a changed app/tenant resets the chain instead of keeping a stale cache", async () => {
    const disk = persistence();
    const api = endpoint();
    await createMsGraphTokenManager({ env: env(), fetchImpl: api.fetchImpl }, disk)();
    await createMsGraphTokenManager({ env: { ...env(), MSGRAPH_REFRESH_TOKEN: "fresh-consent" }, fetchImpl: api.fetchImpl }, disk)();
    await createMsGraphTokenManager({ env: { ...env(), MSGRAPH_TENANT: "different-tenant" }, fetchImpl: api.fetchImpl }, disk)();
    expect(api.used).toEqual(["test-bootstrap", "fresh-consent", "test-bootstrap"]);
  });

  it("coalesces simultaneous readers and reuses an unexpired access token", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "access", refresh_token: "replacement", expires_in: 3600 }));
    const token = createMsGraphTokenManager({ env: env(), fetchImpl }, persistence());
    expect(await Promise.all([token(), token(), token()])).toEqual(["access", "access", "access"]);
    await token();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed if persisting a rotation fails, without leaking the credential", async () => {
    const disk = persistence();
    disk.save.mockImplementation(async () => { throw new Error("private-token-value"); });
    const token = createMsGraphTokenManager({ env: env(), fetchImpl: endpoint().fetchImpl }, disk);
    await expect(token()).rejects.toThrow("could not persist the rotated credential");
  });

  it("keeps the previous stored refresh token when the endpoint omits a replacement", async () => {
    const disk = persistence();
    const ctx = { env: env(), fetchImpl: endpoint().fetchImpl };
    await createMsGraphTokenManager(ctx, disk)();
    const saved = await disk.load();
    const token = createMsGraphTokenManager({ env: env(), fetchImpl: async () => Response.json({ access_token: "still-valid" }) }, disk);
    await token();
    expect(await disk.load()).toEqual(saved);
  });

  it("surfaces an expired grant as actionable sign-in work without raw provider data", async () => {
    const disk = persistence();
    const token = createMsGraphTokenManager({ env: env(), fetchImpl: async () => Response.json({
      error: "invalid_grant", error_description: "AADSTS700082 private-token-value personal-data",
    }, { status: 400 }) }, disk);
    const error = await token().catch((e: Error) => e);
    expect(String(error)).toContain("AADSTS700082");
    expect(String(error)).toContain("operator sign-in required");
    expect(String(error)).not.toContain("private-token-value");
    expect(disk.save).not.toHaveBeenCalled();
  });

  it("all source token reads use the injected runtime manager", async () => {
    const token = vi.fn(async () => "managed-access");
    const fetchImpl = vi.fn();
    await expect(msGraphAccessToken({ env: {}, msGraphToken: token, fetchImpl })).resolves.toBe("managed-access");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the local cache survives restart, is mode 600, and cannot appear in document listings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mesh-credentials-"));
    roots.push(root);
    const api = endpoint();
    const ctx = { env: env(), fetchImpl: api.fetchImpl };
    await localMsGraphTokenManager(root, ctx)();
    await localMsGraphTokenManager(root, ctx)();
    expect(api.used).toEqual(["test-bootstrap", "rotated-1"]);
    const file = path.join(root, "local-only/credentials/msgraph.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(path.dirname(file), ".gitignore"), "utf8")).toBe("*\n");
    expect(JSON.parse(await readFile(file, "utf8")).refreshToken).toBe("rotated-2");
    expect((await nodeSourceFs.listFiles(root, { excludes: [], maxEntries: 20 })).entries).toEqual([]);
    await expect(nodeSourceFs.readTextFile(root, "local-only/credentials/msgraph.json")).rejects.toThrow("private cache");
  });
});
