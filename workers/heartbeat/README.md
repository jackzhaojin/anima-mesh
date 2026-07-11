# workers/heartbeat — the cloud tier

One Cloudflare Worker + one Durable Object run the same heartbeat the CLI
runs, against a **GitHub-hosted** brain: the DO's alarm fires daily at the
instance's configured hour, DST-correct (`alarm-time.ts` — the reason this is
an alarm, not a UTC-fixed cron trigger). A beat reads the instance as one
tarball, runs every due agent whose harness is in `CLOUD_HARNESSES`
(fetch-only cognition — subprocess harnesses are skipped with reason), lands
all artifacts as **one commit**, delivers the hub's brief, and attempts a
failure DM if anything breaks: silence must mean success.

## Routes

| Route | Behavior |
|---|---|
| `GET /healthz` | last beat summary + next alarm (no auth; counts only) |
| `POST /beat` | manual trigger, `authorization: Bearer <BEAT_TRIGGER_TOKEN>`; same mutex as the alarm |
| `GET /.well-known/agent-card.json` | the A2A card, live (`streaming: false` — short connections by design) |

## Deploying

This package is generic and holds **no instance config** —
`wrangler.example.jsonc` is a template. An instance deploys by keeping its
own `wrangler.jsonc` (account id, `BRAIN_REPO`/`BRAIN_REF`/`BEAT_TIMEZONE`/
`BEAT_HOUR` vars, DO binding + `new_sqlite_classes` migration) whose `main`
points at this entry, then `wrangler deploy` + `wrangler secret put` for
`GITHUB_TOKEN`, `MOONSHOT_API_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_DM_USER_ID`,
`BEAT_TRIGGER_TOKEN` (and optionally the `MOONSHOT_BASE_URL` var for
endpoint-scoped keys). Any first request arms the alarm; alarms survive
deploys; secrets persist across deploys.

## Constraints (enforced)

Pure Web platform — no `node:*`, no subprocess providers, no fs store:
`test/workers-imports.test.ts` walks this entry's import graph and fails the
suite on a violation. `pnpm typecheck:worker` (part of root `pnpm verify`)
typechecks against `@cloudflare/workers-types`. Never add a streaming/SSE
endpoint: Durable Objects bill idle wall-clock and SSE has no hibernation.
