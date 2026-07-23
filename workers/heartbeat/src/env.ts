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
  MSGRAPH_TENANT?: string; // Entra tenant id/domain; default "common"
  MSGRAPH_DRIVE_ID?: string; // a specific drive (SharePoint library); default the consenting user's OneDrive
  MSGRAPH_CABINET_PATH?: string; // folder under the drive root that IS the cabinet; default the root
  GITHUB_DOCS_REPO?: string; // "owner/name" — the 'github-docs' source; absent = source unconfigured here
  GITHUB_DOCS_REF?: string; // branch/tag/SHA; default HEAD (the repo's default branch)
  GITHUB_DOCS_PATH?: string; // only list paths under this repo subpath
  // -- secrets --
  GITHUB_APP_ID?: string; // GitHub App auth (preferred): all three or none
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string; // PKCS#8 PEM (convert GitHub's PKCS#1 download first)
  GITHUB_TOKEN?: string; // legacy PAT path — used only when no App var is set
  MOONSHOT_API_KEY: string; // cognition for moonshot-api; optional in practice when no effective agent uses it
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DM_USER_ID?: string; // doubles as the direction sender allowlist (v1: the principal only)
  BEAT_TRIGGER_TOKEN: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string; // subscription OAuth for anthropic-api; plain fetch, no SDK
  GMAIL_CLIENT_ID?: string; // persona Gmail OAuth (inbound poll + reply); send scope exists, modify needs re-consent
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  AGENT_EMAIL?: string; // the persona's sending identity
  MSGRAPH_CLIENT_ID?: string; // OneDrive cabinet, READ-ONLY (delegated Files.Read.All — the 'onedrive' source)
  MSGRAPH_CLIENT_SECRET?: string; // absent for public clients (device-code consent)
  MSGRAPH_REFRESH_TOKEN?: string;
  GITHUB_DOCS_TOKEN?: string; // fine-grained PAT, Contents READ-ONLY on the docs repo; falls back to GITHUB_TOKEN
  GITHUB_DEFECTS_TOKEN?: string; // fine-grained PAT, Issues R/W on the ENGINE repo — defect-report filings
}

/** Flatten the Worker env into the engine's injectable env record. */
export function envRecord(env: Env): Record<string, string | undefined> {
  return {
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_INSTALLATION_ID: env.GITHUB_APP_INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
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
    MSGRAPH_CLIENT_ID: env.MSGRAPH_CLIENT_ID,
    MSGRAPH_CLIENT_SECRET: env.MSGRAPH_CLIENT_SECRET,
    MSGRAPH_REFRESH_TOKEN: env.MSGRAPH_REFRESH_TOKEN,
    MSGRAPH_TENANT: env.MSGRAPH_TENANT,
    MSGRAPH_DRIVE_ID: env.MSGRAPH_DRIVE_ID,
    MSGRAPH_CABINET_PATH: env.MSGRAPH_CABINET_PATH,
    GITHUB_DOCS_REPO: env.GITHUB_DOCS_REPO,
    GITHUB_DOCS_REF: env.GITHUB_DOCS_REF,
    GITHUB_DOCS_PATH: env.GITHUB_DOCS_PATH,
    GITHUB_DOCS_TOKEN: env.GITHUB_DOCS_TOKEN,
    GITHUB_DEFECTS_TOKEN: env.GITHUB_DEFECTS_TOKEN,
  };
}
