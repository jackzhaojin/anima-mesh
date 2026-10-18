import type { Env } from "./env.js";

/** Internal DO-only credential route. There is deliberately no public HTTP route. */
export function cloudMsGraphToken(env: Env): () => Promise<string> {
  return async () => {
    const stub = env.HEARTBEAT_DO.get(env.HEARTBEAT_DO.idFromName("main"));
    const response = await stub.fetch("https://do/msgraph-token", { method: "POST" });
    const result = await response.json() as { token?: string; error?: string };
    if (!response.ok || !result.token) throw new Error(result.error ?? "msgraph credential manager unavailable");
    return result.token;
  };
}
