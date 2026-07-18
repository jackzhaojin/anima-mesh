# Deploying the cloud tier — a generic runbook

*How an instance puts its mesh on Cloudflare Workers. Everything here is an
**instance act**: the engine ships code and `wrangler.example.jsonc`
templates; the filled-in config, account ids, hostnames, and secrets live in
the instance repo (see [engine-vs-instance.md](engine-vs-instance.md)).*

## Prerequisites

- Cloudflare account on **Workers Paid** (Durable Objects require it) and
  `wrangler` (needs Node 22+).
- The brain pushed to a **private GitHub repo**, plus a fine-grained PAT
  (or GitHub App) scoped to that one repo, Contents read/write.
- A cognition credential that works over pure fetch from Workers — and
  **probe the endpoint from a real Worker first**
  ([learnings/2026-07-11](learnings/2026-07-11-workers-egress-waf.md):
  some vendor edges block Workers egress entirely).
- Optional, per surface: a Discord application (bot token + public key) for
  the persona channel; a Google OAuth web client for the dashboard; Gmail
  OAuth bits for the email poll.

## The instance-side workspace

In the brain repo, keep a small deploy workspace (conventionally `cloud/`)
holding a `wrangler.jsonc` per Worker whose `main` points at the engine
checkout's entry:

```
your-brain/
  cloud/
    wrangler.jsonc          # heartbeat Worker: account_id, name, vars, DO bindings
    web/wrangler.jsonc      # web Worker (separate name, separate deploy)
```

Copy each from the engine's `workers/*/wrangler.example.jsonc` and fill in:

| Heartbeat vars | Meaning |
|---|---|
| `BRAIN_REPO` / `BRAIN_REF` | `owner/name` and branch of the brain |
| `BEAT_TIMEZONE` / `BEAT_HOUR` | when the daily beat fires, local-calendar semantics |
| `DISCORD_PUBLIC_KEY` | the Discord app's request-verification key (inbound directions) |
| `DIRECTION_DAILY_CAP` | direction budget per day (e.g. `20`) |
| `DIRECTION_GMAIL_POLL_MINUTES` / `DIRECTION_GMAIL_ALLOWED_FROM` | email poll; unset = off |
| `MSGRAPH_TENANT` / `MSGRAPH_DRIVE_ID` / `MSGRAPH_CABINET_PATH` | where the 'onedrive' read source points; all optional |
| `GITHUB_DOCS_REPO` / `GITHUB_DOCS_REF` / `GITHUB_DOCS_PATH` | where the 'github-docs' read source points (`owner/name`, ref default `HEAD`, optional subpath); unset = source unconfigured |

Both Durable Objects need bindings + a `new_sqlite_classes` migration —
the example file shows the shape.

| Heartbeat secrets (`wrangler secret put`) | Purpose |
|---|---|
| `GITHUB_TOKEN` | read + commit the brain |
| `MOONSHOT_API_KEY` and/or `CLAUDE_CODE_OAUTH_TOKEN` | cognition (whatever the agents' effective harnesses need) |
| `DISCORD_BOT_TOKEN` / `DISCORD_DM_USER_ID` | brief + failure DMs; the direction sender gate |
| `BEAT_TRIGGER_TOKEN` | gates manual `POST /beat` (mint with `openssl rand -hex 32`) |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` / `AGENT_EMAIL` | only if the email surfaces are on |
| `MSGRAPH_CLIENT_ID` / `MSGRAPH_REFRESH_TOKEN` (+ `MSGRAPH_CLIENT_SECRET` for confidential clients) | the 'onedrive' read source (agents opting in via `sources:` frontmatter); delegated read-only consent; validate with bearer-gated `GET /graph/check` |
| `GITHUB_DOCS_TOKEN` | the 'github-docs' read source: fine-grained PAT, Contents READ-ONLY on the docs repo only (falls back to `GITHUB_TOKEN`; public repos need none); validate with bearer-gated `GET /docs/check` |

The web Worker's contract is in
[workers/web/README.md](../workers/web/README.md) — narrower on purpose.

**Give the dashboard a public DNS name.** Google OAuth needs a stable HTTPS
origin for its redirect URI, and `*.workers.dev` hostnames are ugly to brand
and easy to fat-finger into the wrong consent screen. If the instance owns a
domain on its Cloudflare zone, one line in the web Worker's config does
everything (DNS record, certificate, routing):

```jsonc
"routes": [{ "pattern": "dash.example.com", "custom_domain": true }]
```

Deploy, and the Worker answers at `https://dash.example.com`; the OIDC
redirect URI derives from the request origin, so it becomes
`https://dash.example.com/auth/callback` with no code or var changes.
Register exactly that URI on the Google OAuth client. (The `workers.dev`
route is disabled automatically once a custom domain exists — one hostname,
one origin, one redirect URI.)

## Deploy and verify

```bash
cd your-brain/cloud
npx wrangler deploy                  # code + vars; secrets persist across deploys
curl https://<worker-host>/healthz   # lastBeat counts + nextAlarm
npx wrangler tail                    # watch a beat live
```

Any first request arms the alarm (idempotent). To prove the pipeline without
waiting for the alarm: `POST /beat` with the bearer token, then check
`/healthz` and the brain's `git log` for the mesh-authored commit.

## Wiring Discord (inbound directions)

1. In the Discord developer portal: register a `/direct` slash command and
   set the **Interactions Endpoint URL** to `https://<worker-host>/interactions`
   — Discord sends a signed PING; the Worker's Ed25519 verification must
   answer PONG for the portal to accept it (a live production test of the
   auth path).
2. Authorize the app (user-install) so the command appears in DMs.
3. The sender gate is `DISCORD_DM_USER_ID`; everyone else is silently
   dropped and ledgered.

## Operating notes

- **The cloud is a second writer to your brain repo.** Every beat and every
  direction commits its evidence straight to the instance's GitHub repo,
  authored by the mesh identity (e.g. `animamesh-cloud`). A local clone
  drifts on its own — `git pull --rebase` before you work, and use
  `git log --author=<mesh-identity>` to see what ran while you were away. The
  writers are safe together: the CLI rebases before committing, the cloud
  store appends one commit per run and never force-pushes.
- **Rotation drill:** rotate at the provider → `wrangler secret put` again →
  next beat proves it (no deploy needed) → note it in the instance log.
- **Don't deploy while a beat is in flight** — a deploy evicts the running
  DO isolate mid-request; the beat lock then self-heals after 30 minutes
  (tracked as an engine issue).
- **Watch token expiries** (PATs especially) — the mesh dies quietly at the
  GitHub seam when they lapse; put the expiry date in the instance's nag
  file.
- `/healthz` is deliberately counts-only (failure strings can carry repo
  coordinates); full detail lives in the token-gated `/beat` response,
  `wrangler tail`, and the git history.

## Running several companies

The engine is a codebase, not a service — there is nothing shared to
multi-tenant. Each company = its own brain repo + its own deploy workspace +
its own Worker names + its own secrets. Deploy N heartbeat Workers from the
same engine checkout under different names and they never touch each other.
See [starting-a-company.md](starting-a-company.md).
