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
  CODEX_BASE_URL?: string; // codex-api endpoint override; default the ChatGPT-plan Codex endpoint
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
  GMAIL_READ_QUERY?: string; // 'gmail' source search; default inbox, last 2 days, no promotions/social/forums
  GMAIL_READ_MAX?: string; // messages per run; default 20, cap 50
  GMAIL_READ_BODIES?: string; // "true" inlines clipped bodies; default snippets only
  GCAL_READ_CALENDARS?: string; // 'google-calendar' source calendar ids, comma-separated; default "primary"
  GCAL_READ_DAYS_AHEAD?: string; // default 14
  GCAL_READ_DAYS_BACK?: string; // default 1
  GCAL_READ_DESCRIPTIONS?: string; // "true" inlines clipped event descriptions
  // -- secrets --
  GITHUB_APP_ID?: string; // GitHub App auth (preferred): all three or none
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string; // PKCS#8 PEM (convert GitHub's PKCS#1 download first)
  GITHUB_TOKEN?: string; // PAT path for the brain store — a standing long-lived PAT is a first-class setup (v0.11.2); used when no App var is set
  MOONSHOT_API_KEY: string; // cognition for moonshot-api; optional in practice when no effective agent uses it
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DM_USER_ID?: string; // doubles as the direction sender allowlist (v1: the principal only)
  BEAT_TRIGGER_TOKEN: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string; // subscription OAuth for anthropic-api; plain fetch, no SDK
  ANTHROPIC_API_KEY?: string; // Console API key for anthropic-api-key: METERED credits, capped by the Console spend limit
  CODEX_REFRESH_TOKEN?: string; // codex-api seed: a DEDICATED `codex login`'s refresh token; rotations live in HeartbeatDO storage
  CODEX_ACCOUNT_ID?: string; // optional: ChatGPT account id (otherwise read from the token claims)
  GMAIL_CLIENT_ID?: string; // persona Gmail OAuth (inbound poll + reply); send scope exists, modify needs re-consent
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  AGENT_EMAIL?: string; // the persona's sending identity
  MSGRAPH_CLIENT_ID?: string; // OneDrive cabinet, READ-ONLY (delegated Files.Read.All — the 'onedrive' source)
  MSGRAPH_CLIENT_SECRET?: string; // absent for public clients (device-code consent)
  MSGRAPH_REFRESH_TOKEN?: string;
  GITHUB_DOCS_TOKEN?: string; // fine-grained PAT, Contents READ-ONLY on the docs repo; falls back to GITHUB_TOKEN
  GITHUB_DEFECTS_TOKEN?: string; // PAT with Issues R/W on the ENGINE repo — the STANDARD posture (v0.11.2): set it and leak-clean defect reports auto-file as issues
  GOOGLE_READ_CLIENT_ID?: string; // the PRINCIPAL's Google account, READ-ONLY (gmail.readonly + calendar.readonly) - 'gmail' / 'google-calendar' sources
  GOOGLE_READ_CLIENT_SECRET?: string;
  GOOGLE_READ_REFRESH_TOKEN?: string; // minted on the laptop by `anima-mesh connect google`
  // BRAIN_LINK_<ID>_TOKEN (one per linked brain, any number): a READ-ONLY
  // token for that brain's repo - the 'brains' source. Passed through by
  // name pattern below; never falls back to GITHUB_TOKEN.
  [linkToken: `BRAIN_LINK_${string}_TOKEN`]: string | undefined;
}

/** Linked-brain read tokens travel by name pattern - there can be any number of links. */
const LINK_TOKEN_RE = /^BRAIN_LINK_[A-Z0-9_]+_TOKEN$/;

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
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    CODEX_REFRESH_TOKEN: env.CODEX_REFRESH_TOKEN,
    CODEX_ACCOUNT_ID: env.CODEX_ACCOUNT_ID,
    CODEX_BASE_URL: env.CODEX_BASE_URL,
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
    GOOGLE_READ_CLIENT_ID: env.GOOGLE_READ_CLIENT_ID,
    GOOGLE_READ_CLIENT_SECRET: env.GOOGLE_READ_CLIENT_SECRET,
    GOOGLE_READ_REFRESH_TOKEN: env.GOOGLE_READ_REFRESH_TOKEN,
    GMAIL_READ_QUERY: env.GMAIL_READ_QUERY,
    GMAIL_READ_MAX: env.GMAIL_READ_MAX,
    GMAIL_READ_BODIES: env.GMAIL_READ_BODIES,
    GCAL_READ_CALENDARS: env.GCAL_READ_CALENDARS,
    GCAL_READ_DAYS_AHEAD: env.GCAL_READ_DAYS_AHEAD,
    GCAL_READ_DAYS_BACK: env.GCAL_READ_DAYS_BACK,
    GCAL_READ_DESCRIPTIONS: env.GCAL_READ_DESCRIPTIONS,
    ...Object.fromEntries(
      Object.entries(env as unknown as Record<string, unknown>).filter(
        (entry): entry is [string, string] => LINK_TOKEN_RE.test(entry[0]) && typeof entry[1] === "string",
      ),
    ),
  };
}
