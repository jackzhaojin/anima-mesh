import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * The Worker's runtime test suite: vitest inside REAL workerd (not Node) —
 * the router, the Durable Object alarm/mutex, and full beats run exactly as
 * deployed, with every outbound service (GitHub, Kimi, Discord) scripted via
 * `fetchMock` from cloudflare:test. Zero network, zero secrets, zero laptop
 * state. `pnpm test:worker` from the engine root; part of `pnpm verify`.
 *
 * Pinned to vitest 3.2.x + pool 0.12.x (the last vitest-3 line, matching the
 * engine root's vitest). The 0.13+ pool requires vitest 4 and replaces both
 * defineWorkersConfig and fetchMock — migrate deliberately, with the
 * shipped codemod, not by accident.
 */
export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        singleWorker: true,
        // isolatedStorage's stack-frame copier asserts bare .sqlite files and
        // trips over live WAL sidecars (.sqlite-shm) from an active DO. Tests
        // run serially (singleWorker) and wipe DO storage + alarm in their
        // own beforeEach — explicit, deterministic, no stack machinery.
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: "2026-07-01",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            HEARTBEAT_DO: { className: "HeartbeatDO", useSQLite: true },
            DIRECTION_DO: { className: "DirectionDO", useSQLite: true },
          },
          bindings: {
            // Mirrors the production Env contract (src/env.ts) with obviously
            // fake values; MOONSHOT_BASE_URL points at a fetchMock origin.
            BRAIN_REPO: "owner/brain",
            BRAIN_REF: "main",
            BEAT_TIMEZONE: "America/New_York",
            BEAT_HOUR: "8",
            MOONSHOT_BASE_URL: "https://fake-kimi.test/v1",
            GITHUB_TOKEN: "test-gh-token-not-real",
            MOONSHOT_API_KEY: "test-kimi-key-not-real",
            DISCORD_BOT_TOKEN: "test-bot-token-not-real",
            DISCORD_DM_USER_ID: "42",
            BEAT_TRIGGER_TOKEN: "test-beat-token",
            // TEST-ONLY Ed25519 keypair (public half here, private half in
            // test/fixtures.ts) — gates nothing real anywhere.
            DISCORD_PUBLIC_KEY: "e9d8505cd226e86f86d1f1eb538dbd506de6e8fa2e43e8e420416c554c36facc",
            DIRECTION_DAILY_CAP: "3",
          },
        },
      },
    },
  },
});
