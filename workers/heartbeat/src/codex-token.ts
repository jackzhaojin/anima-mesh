import {
  codexAuthSource,
  type CodexAuth,
  type CodexAuthSource,
  type CodexTokens,
  type CodexTokenStore,
} from "../../../src/providers/codex-auth.js";
import { envRecord, type Env } from "./env.js";

/**
 * The Worker's ONE owner of the Codex (ChatGPT-plan) login. Refresh tokens
 * rotate, so every refresh must be serialized and persisted in a single
 * place: HeartbeatDO's storage, behind codexAuthSource's mutex. The beat
 * (running inside HeartbeatDO) calls the source directly; DirectionDO asks
 * HeartbeatDO over its internal `/codex-token` route rather than refreshing
 * on its own — two DOs refreshing one chain would spend each other's tokens.
 */
const CODEX_TOKENS_KEY = "codex-tokens";

export function doCodexTokenStore(storage: DurableObjectStorage): CodexTokenStore {
  return {
    load: () => storage.get<CodexTokens>(CODEX_TOKENS_KEY),
    save: (t) => storage.put(CODEX_TOKENS_KEY, t),
  };
}

export function heartbeatCodexAuth(storage: DurableObjectStorage, env: Env): CodexAuthSource {
  return codexAuthSource(doCodexTokenStore(storage), { env: envRecord(env) });
}

/** DirectionDO's view: the same source, reached through HeartbeatDO. */
export function remoteCodexAuth(env: Env): CodexAuthSource {
  return async ({ force } = {}) => {
    const stub = env.HEARTBEAT_DO.get(env.HEARTBEAT_DO.idFromName("main"));
    const res = await stub.fetch("https://do/codex-token", {
      method: "POST",
      body: JSON.stringify({ force: force ?? false }),
    });
    const json = (await res.json()) as CodexAuth & { error?: string };
    if (!res.ok || json.error) throw new Error(json.error ?? `codex-token → HTTP ${res.status}`);
    return { accessToken: json.accessToken, accountId: json.accountId };
  };
}
