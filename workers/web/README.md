# workers/web — the principal's dashboard (Google OIDC, allowlist-only)

A separate Cloudflare Worker serving a **founder-only observability surface**
over a GitHub-hosted brain: last beat, ledger tail, recent reports, pending
approvals, engine pin — plus one action, *trigger a beat now*. It exists so
the principal can see the mesh without SSHing anywhere; it deliberately
cannot do anything else.

## Security posture (strict by construction)

- **Nothing is served unauthenticated.** Every route except the OAuth
  handshake requires a valid session; strangers get a login redirect, and
  non-allowlisted Google identities are rejected *after* authentication.
- **Auth is in-Worker Google OIDC** (authorization-code flow over plain
  fetch — no Auth.js, no framework): HMAC-signed `state`, direct code
  exchange with Google, `iss`/`aud`/`exp`/`email_verified` claim checks, and
  the email allowlist (`WEB_ALLOWED_EMAILS`) re-checked on **every request**,
  so removing an email locks that person out mid-session.
- **Sessions are HMAC-signed cookies** keyed by `SESSION_SECRET` — rotate the
  secret to invalidate every session at once. `POST /actions/beat` also
  checks the `Origin` header (CSRF).
- **The env contract is deliberately narrow** (`src/env.ts`): this Worker
  holds read access to the brain and the beat-trigger token — never
  cognition keys or persona channel secrets. A web-tier compromise can
  neither think nor speak as the mesh.

## Routes

| Route | What |
|---|---|
| `GET /` | the dashboard (server-rendered HTML, no client JS framework) |
| `GET /auth/login` → Google → `GET /auth/callback` | OIDC handshake |
| `POST /logout` | clears the session cookie |
| `POST /actions/beat` | proxies to the heartbeat Worker's token-gated `/beat`; the browser never sees `BEAT_TRIGGER_TOKEN` |

## Deploying (an instance act)

The engine ships `wrangler.example.jsonc` only. An instance copies it into
its own repo, fills vars (`BRAIN_REPO`, `BRAIN_REF`, `WEB_ALLOWED_EMAILS`,
`HEARTBEAT_URL`), points `main` at this package, and loads secrets via
`wrangler secret put`: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
(a Google Cloud "Web application" OAuth client whose redirect URI is
`https://<worker-host>/auth/callback` — **name the client after the
dashboard's hostname**, not the engine: one client per company, and
hostname-named clients stay distinguishable when you run several),
`SESSION_SECRET`, brain read auth (the GitHub App trio, or legacy
`GITHUB_TOKEN`), `BEAT_TRIGGER_TOKEN`.

**Recommended: a custom domain** on the instance's Cloudflare zone
(`"routes": [{ "pattern": "dash.example.com", "custom_domain": true }]`) —
a stable, branded origin for Google's redirect URI; the OIDC flow derives
its redirect from the request origin, so no other change is needed. A staged
deploy (custom domain + `SESSION_SECRET`/brain-auth secrets/`BEAT_TRIGGER_TOKEN`,
Google secrets later) is safe: the anonymous surface is a sign-in link and
nothing else, and login simply fails until the client exists.

## Tests

`pnpm test` here runs the workerd-local suite (`@cloudflare/vitest-pool-workers`):
OIDC state tampering, claim validation, allowlist enforcement (including
revocation mid-session), cookie signing, CSRF, and dashboard rendering
against a mocked GitHub + heartbeat. Part of the engine's root `pnpm verify`.
