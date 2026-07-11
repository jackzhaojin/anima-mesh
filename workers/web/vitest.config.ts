import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * The web Worker's runtime suite: vitest inside REAL workerd — the OIDC
 * flow against a scripted Google, session forgery, the allowlist, and the
 * dashboard rendered from a scripted GitHub + heartbeat. Same pins and
 * quirk-handling as workers/heartbeat (see that vitest.config.ts).
 */
export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        singleWorker: true,
        isolatedStorage: false, // no DOs here; nothing to isolate
        miniflare: {
          compatibilityDate: "2026-07-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            BRAIN_REPO: "owner/brain",
            BRAIN_REF: "main",
            WEB_ALLOWED_EMAILS: "principal@example.test",
            HEARTBEAT_URL: "https://heartbeat.test",
            DASHBOARD_TITLE: "Test Mesh Ops",
            GOOGLE_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
            GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret-not-real",
            SESSION_SECRET: "test-session-secret-not-real",
            GITHUB_TOKEN: "test-gh-token-not-real",
            BEAT_TRIGGER_TOKEN: "test-beat-token",
          },
        },
      },
    },
  },
});
