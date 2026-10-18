import { getEnv } from "../instance/env-core.js";
import { redeemMsGraphToken } from "./msgraph.js";
import type { SourceContext } from "./types.js";

export interface MsGraphCredential {
  /** Binds the rotation chain to the configured bootstrap credential, tenant, app, and scope. */
  bootstrapHash: string;
  refreshToken: string;
}

export interface MsGraphCredentialStore {
  load(): Promise<MsGraphCredential | undefined>;
  save(value: MsGraphCredential): Promise<void>;
}

/**
 * Workers-safe credential lifecycle. Never write tokens to the InstanceStore:
 * the runtime supplies private persistence (DO storage or a mode-600 local file).
 * One in-flight exchange prevents concurrent readers from losing a rotation.
 */
export function createMsGraphTokenManager(ctx: SourceContext, store: MsGraphCredentialStore): () => Promise<string> {
  let pending: Promise<string> | undefined;
  let cached: { bootstrapHash: string; token: string; until: number } | undefined;
  const exchange = async (): Promise<string> => {
    const bootstrap = getEnv(ctx.env, "MSGRAPH_REFRESH_TOKEN") ?? "";
    const identity = JSON.stringify([
      getEnv(ctx.env, "MSGRAPH_CLIENT_ID"), getEnv(ctx.env, "MSGRAPH_TENANT") || "common",
      getEnv(ctx.env, "MSGRAPH_SCOPE") || "https://graph.microsoft.com/Files.Read.All offline_access", bootstrap,
    ]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    const bootstrapHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (cached?.bootstrapHash === bootstrapHash && cached.until > Date.now()) return cached.token;
    const saved = await store.load();
    const refreshToken = saved?.bootstrapHash === bootstrapHash ? saved.refreshToken : bootstrap;
    const result = await redeemMsGraphToken(ctx, refreshToken);
    if (typeof result.refresh_token === "string" && result.refresh_token) {
      try {
        await store.save({ bootstrapHash, refreshToken: result.refresh_token });
      } catch {
        throw new Error("msgraph: could not persist the rotated credential; source read stopped");
      }
    } else {
      ctx.log?.("msgraph: token endpoint returned no replacement refresh token; rotation was not advanced");
    }
    const seconds = Number(result.expires_in);
    cached = { bootstrapHash, token: result.access_token, until: Date.now() + Math.max(0, (Number.isFinite(seconds) ? seconds - 60 : 0) * 1000) };
    return result.access_token;
  };
  return () => {
    if (!pending) pending = exchange().finally(() => { pending = undefined; });
    return pending;
  };
}
