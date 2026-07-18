# workers/heartbeat — the cloud tier

One Cloudflare Worker + two Durable Objects run the same mesh the CLI runs,
against a **GitHub-hosted** brain.

Agents may also opt into read-only prompt sources through `sources:`
frontmatter. The Worker supports `onedrive` over Microsoft Graph and
`github-docs` over GitHub REST; source listings are assembled into the prompt,
and a source failure is represented as missing context rather than aborting a
run.

**`HeartbeatDO` — the scheduled side.** Its alarm fires daily at the
instance's configured hour, DST-correct (`alarm-time.ts` — the reason this is
an alarm, not a UTC-fixed cron trigger). A beat reads the instance as one
tarball, runs every due agent whose harness is in `CLOUD_HARNESSES`
(fetch-only cognition — subprocess harnesses are skipped with reason), lands
all artifacts as **one commit**, delivers the hub's brief, and attempts a
failure DM if anything breaks: silence must mean success.

**`DirectionDO` — the inbound side.** `POST /interactions` receives Discord
slash commands, verified against the app's Ed25519 public key
(`interactions.ts`); non-principal senders are silently dropped (and
ledgered), the per-day budget (`DIRECTION_DAILY_CAP`) returns an ephemeral
"budget spent" reply, and accepted directions are queued in the DO with an
immediate alarm. The drain runs each direction agentically
(`runDirectionCore`), lands **one commit per drain**, and only then sends the
deferred Discord reply — evidence before words. The same DO optionally polls
a Gmail inbox for principal email (`DIRECTION_GMAIL_POLL_MINUTES`,
`DIRECTION_GMAIL_ALLOWED_FROM`) with a processed-id dedup ring.

## Routes

| Route | Behavior |
|---|---|
| `GET /healthz` | last beat summary + next alarm (no auth; counts only) |
| `POST /beat` | manual trigger, `authorization: Bearer <BEAT_TRIGGER_TOKEN>`; same mutex as the alarm |
| `POST /interactions` | Discord interactions endpoint (Ed25519-verified; 401 otherwise) |
| `GET /graph/check` | bearer-gated validation for the configured `onedrive` source |
| `GET /docs/check` | bearer-gated validation for the configured `github-docs` source |
| `GET /.well-known/agent-card.json` | the A2A card, live (`streaming: false` — short connections by design) |

## Deploying

This package is generic and holds **no instance config** —
`wrangler.example.jsonc` is a template. An instance deploys by keeping its
own `wrangler.jsonc` (account id, `BRAIN_REPO`/`BRAIN_REF`/`BEAT_TIMEZONE`/
`BEAT_HOUR`/`DISCORD_PUBLIC_KEY`/`DIRECTION_DAILY_CAP` vars, both DO bindings
plus optional `MSGRAPH_*`/`GITHUB_DOCS_*` source vars, and
`new_sqlite_classes` migrations) whose `main` points at this entry, then
`wrangler deploy` + `wrangler secret put` for the GitHub App trio
`GITHUB_APP_ID`/`GITHUB_APP_INSTALLATION_ID`/`GITHUB_APP_PRIVATE_KEY`
(or legacy `GITHUB_TOKEN`), cognition keys
(`MOONSHOT_API_KEY` and/or `CLAUDE_CODE_OAUTH_TOKEN`), `DISCORD_BOT_TOKEN`,
`DISCORD_DM_USER_ID`, `BEAT_TRIGGER_TOKEN` (and optionally the
`MOONSHOT_BASE_URL` var for endpoint-scoped keys, `GMAIL_*` for the email
poll). Any first request arms the alarm; alarms survive deploys; secrets
persist across deploys. The full generic runbook:
[docs/deploying-cloud.md](../../docs/deploying-cloud.md).

## Constraints (enforced)

Pure Web platform — no `node:*`, no subprocess providers, no fs store:
`test/workers-imports.test.ts` walks this entry's import graph and fails the
suite on a violation. `pnpm typecheck:worker` (part of root `pnpm verify`)
typechecks against `@cloudflare/workers-types`. Never add a streaming/SSE
endpoint: Durable Objects bill idle wall-clock and SSE has no hibernation.
