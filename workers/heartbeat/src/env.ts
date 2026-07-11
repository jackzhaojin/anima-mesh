/**
 * The Worker's environment contract. Vars come from wrangler.jsonc (the
 * REAL config lives in the instance repo's cloud/ workspace — this engine
 * package ships only wrangler.example.jsonc); secrets via `wrangler secret put`.
 */
export interface Env {
  // -- bindings --
  HEARTBEAT_DO: DurableObjectNamespace;
  // -- vars (strings; coerce numbers explicitly) --
  BRAIN_REPO: string; // "owner/name"
  BRAIN_REF: string; // "main"
  BEAT_TIMEZONE: string; // IANA, e.g. "America/New_York"
  BEAT_HOUR: string; // "8"
  MOONSHOT_BASE_URL?: string; // set when the key is endpoint-scoped (subscription keys)
  // -- secrets --
  GITHUB_TOKEN: string;
  MOONSHOT_API_KEY: string; // the cloud tier's ONLY cognition key (no Claude key exists on Workers)
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DM_USER_ID?: string;
  BEAT_TRIGGER_TOKEN: string;
}

/** Flatten the Worker env into the engine's injectable env record. */
export function envRecord(env: Env): Record<string, string | undefined> {
  return {
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    MOONSHOT_API_KEY: env.MOONSHOT_API_KEY,
    MOONSHOT_BASE_URL: env.MOONSHOT_BASE_URL,
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    DISCORD_DM_USER_ID: env.DISCORD_DM_USER_ID,
  };
}
