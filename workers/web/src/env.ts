/**
 * The web Worker's environment contract. Deliberately NARROW (doc-02
 * topology): this Worker reads the brain and pokes the heartbeat — it never
 * holds cognition or persona-channel secrets, so a web-tier bug can neither
 * think nor speak as the persona.
 */
export interface Env {
  // -- vars --
  BRAIN_REPO: string; // "owner/name"
  BRAIN_REF: string; // "main"
  /** Comma-separated allowlist; the ONLY identities that may log in (A2/A3). */
  WEB_ALLOWED_EMAILS: string;
  /** Base URL of the heartbeat Worker (healthz + trigger-beat proxy). */
  HEARTBEAT_URL: string;
  /** Dashboard heading. Default "AnimaMesh". */
  DASHBOARD_TITLE?: string;
  // -- secrets --
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  /** HMAC key for state + session cookies. Rotate to invalidate all sessions. */
  SESSION_SECRET: string;
  /** Read access to the brain repo (the dashboard's data). */
  GITHUB_TOKEN: string;
  /** Held server-side for the trigger-beat proxy; the browser never sees it. */
  BEAT_TRIGGER_TOKEN: string;
}
