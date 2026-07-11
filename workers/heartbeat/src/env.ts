/**
 * The Worker's environment contract. Vars come from wrangler.jsonc (the
 * REAL config lives in the instance repo's cloud/ workspace — this engine
 * package ships only wrangler.example.jsonc); secrets via `wrangler secret put`.
 */
export interface Env {
  // -- bindings --
  HEARTBEAT_DO: DurableObjectNamespace;
  DIRECTION_DO: DurableObjectNamespace;
  // -- vars (strings; coerce numbers explicitly) --
  BRAIN_REPO: string; // "owner/name"
  BRAIN_REF: string; // "main"
  BEAT_TIMEZONE: string; // IANA, e.g. "America/New_York"
  BEAT_HOUR: string; // "8"
  MOONSHOT_BASE_URL?: string; // set when the key is endpoint-scoped (subscription keys)
  DISCORD_PUBLIC_KEY?: string; // the Discord app's Ed25519 verify key (public info); absent = /interactions is 404
  DIRECTION_DAILY_CAP?: string; // max direction runs per local day; default 20 (decision Q4)
  DIRECTION_GMAIL_POLL_MINUTES?: string; // Gmail poll cadence; 0/absent = inbound email off (decision Q3b)
  DIRECTION_GMAIL_ALLOWED_FROM?: string; // only mail from this address becomes a direction (decision Q6)
  // -- secrets --
  GITHUB_TOKEN: string;
  MOONSHOT_API_KEY: string; // the cloud tier's ONLY cognition key (no Claude key exists on Workers)
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DM_USER_ID?: string; // doubles as the direction sender allowlist (v1: the principal only)
  BEAT_TRIGGER_TOKEN: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string; // subscription OAuth for the anthropic-api harness (decision 2026-07-11 — supersedes the never-on-Workers posture; plain fetch, no SDK)
  GMAIL_CLIENT_ID?: string; // persona Gmail OAuth (inbound poll + reply); send scope exists, modify needs re-consent
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  AGENT_EMAIL?: string; // the persona's sending identity
}

/** Flatten the Worker env into the engine's injectable env record. */
export function envRecord(env: Env): Record<string, string | undefined> {
  return {
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    MOONSHOT_API_KEY: env.MOONSHOT_API_KEY,
    MOONSHOT_BASE_URL: env.MOONSHOT_BASE_URL,
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    DISCORD_DM_USER_ID: env.DISCORD_DM_USER_ID,
    CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
    GMAIL_CLIENT_ID: env.GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET: env.GMAIL_CLIENT_SECRET,
    GMAIL_REFRESH_TOKEN: env.GMAIL_REFRESH_TOKEN,
    AGENT_EMAIL: env.AGENT_EMAIL,
  };
}
