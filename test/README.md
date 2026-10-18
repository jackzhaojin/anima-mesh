# test/ — the regression suite

`pnpm verify` = typecheck (src **and** test) + this suite + both Workers'
typechecks and suites (`typecheck:worker`/`test:worker` for the heartbeat
Worker, `typecheck:web`/`test:web` for the web Worker). It is the contract:
green before every commit, no exceptions. No network, no real model calls, no static fixtures —
everything builds in temp dirs via `helpers.ts` and runs against
`FakeProvider`.

## What each file guarantees

- **okf.test.ts** — frontmatter round-trips; malformed YAML throws (never
  silently repaired); bundle walking is deterministic and skips dot-dirs;
  conformance catches missing index/log, missing `type`, non-immutable
  constitutions, undated decisions, agent concepts without chokepoint fields;
  broken links warn without failing.
- **okf-v02.test.ts** - OKF v0.2 (v2.2.0): actor parsing, offset-required
  datetimes, trust tiers (a malformed `verified` never forges one),
  lifecycle default and staleness, every family warning (and the spec's own
  example staying clean); reserved files aren't concepts; `okf_version`;
  `/bundle-relative` links; agent `context-sources:` and the legacy warning;
  schemas can't give `status` domain values; newest-first log writing,
  legacy log conversion that keeps every word and is idempotent; `okf
  migrate` (comments survive, judgment calls reported, migrated bundle
  validates clean, CLI dry-run vs `--write`); the harness's Knowledge trust
  section; the agent card titling from the index H1.
- **ledger-gates.test.ts** — the safety layer as behavior: ledgers only grow;
  corruption is detected; approvals are terminal; the ladder blocks
  above-level actions; gated types without a *matching approved* record throw
  (pending, denied, and wrong-type all rejected); L3 whitelists enforced;
  constitution gate lists union with the floor, never replace it.
- **harness.test.ts** — a full heartbeat end-to-end: report artifact with
  frontmatter, three ledger entries in order, all verifiers green; prompts are
  assembled from the bundle (never recall) and include latest mesh reports +
  pending approvals; commercial agents refuse to run without the dual gate;
  a conformance break in the bundle fails the run.
- **init.test.ts** — the PRD acceptance test: empty dir → conformant brain
  (re-checked independently, not trusting the scaffolder); placeholders fully
  substituted; non-empty targets refused; a scaffolded brain immediately
  completes a run; agentic enrichment adopts valid suggestions, strips unknown
  agents, survives fenced/prose JSON, falls back on garbage, and never
  overrides an explicit human choice.
- **cli.test.ts** - the CLI (14 commands) driven in-process (`main(argv)` →
  exit code): init/validate/run/gate/report/templates plus
  `defect list`/`defect file` — including the v0.11.3 positional-parsing
  regression: `defect file --instance <dir>` must never read the flag value
  as a subcommand or slug (exit 2) — and failure exits throughout.
- **capabilities.test.ts** — the issue #4 regression suite, the v0.12
  capability contract: the prompt states what the harness grants and that it
  overrides the job description; a declared-but-unavailable `web:` budget is
  LOUD ("do NOT attempt fetches, report the gap"); the budget reaches the
  provider only when the harness can search; an undeclared provider reads as
  `NO_CAPABILITIES`; `web:` frontmatter parsing (opt-in, nonsense = 0).
- **cognition-override.test.ts** — `cognition.overrides`: declared harness
  stays the agent's identity while the override runs; evidence records what
  actually ran; the cloud gate judges the EFFECTIVE harness both directions;
  directions honor the override too.
- **schedule.test.ts** — the `ops/schedule.md` surface: wakes consumed in
  place and ledgered, pause beats wake (the contradiction stays on file),
  cadence overrides change the due decision, wakes never bypass the tier or
  the commercial dual gate, the gated `schedule-request` path (L3 + whitelist
  applies; L1 or missing whitelist denied), and schedule conformance.
- **drafts.test.ts** — `draft-request` blocks, model proposes / code
  disposes: parse/strip, the path jail, L3-with-whitelist applies while L1 is
  denied, escapes jailed, runaway runs capped — and the direction-run
  DM-to-artifact loop.
- **defects.test.ts** — the defect loop: block parsing, the identity-leak
  guard (D2/D13 at the public boundary), issue-first with a token (labeled
  issue, UA header, title-dedup, NO draft), draft fallback on no-token / API
  failure / leak, whitelist denial, the per-run cap, and `defect file`
  promotion re-running the leak guard on current content.
- **direction.test.ts** — `runDirectionCore`: evidence artifact + the
  `direction-*` ledger trio, a midday direction never eats the daily dedup,
  brief delivery stays blind to direction artifacts, agent resolution order,
  the 1900-char reply cap, and the commercial dual gate holding.
- **local-agents.test.ts** — the local-surface compile contract: both
  artifacts with identical persona bodies and surface-specific frontmatter,
  hub-under-persona naming, roster selection honoring D11 (dual-gated agents
  skipped by `--all`, loud on explicit request), `exportLocalAgents` + the
  CLI command + scaffold writing artifacts out of the box.
- **github-auth.test.ts** — `githubToken`: the PAT path with zero network,
  the App path minting an installation token with a verifiable RS256 JWT +
  User-Agent, near-expiry caching, App-over-PAT precedence, loud
  partial-config failure, and the PKCS#1 conversion hint.
- **github-docs.test.ts** — the `github-docs` source both ways: REST listing
  (User-Agent always, token fallback chain, bounds + truncation surfaced)
  and the local working tree via injected `SourceFs` (same scoping, API
  fallback when the capability is absent); binary refusal, root-escape
  refusal, and outages becoming honest prompt sections, never aborted runs.
- **gmail-inbound.test.ts** — the inbound Gmail poll: unread-from-allowlisted
  senders only (never open), the From header re-checked client-side, one
  unreadable message never kills the poll, mark-read as the dedup contract.
- **msgraph.test.ts** — the `onedrive` source: refresh grant with NO secret
  for public clients, bounded breadth-first cabinet walk following shortcuts
  into remote drives, pagination, truncation reported instead of walking
  forever, clipped text-only reads, and unconfigured/outage = honest
  sections.
- **channels.test.ts / heartbeat-card.test.ts** — delivery channels against
  mocked fetch (env injection, per-channel auth failures); heartbeat
  due/skip/dedup semantics; the agent card excludes dual-gated agents and
  declares `streaming: false`. Slack delivery: markdown blocks, a long brief
  threaded under its head, Slack's HTTP-200 `ok:false` treated as failure.
- **slack-listen.test.ts**: the laptop-tier Slack ear (v2.3.1-v2.3.2):
  answers an allowlisted mention in its thread after the evidence, the
  ledger as the dedup (a second pass answers nothing), denials recorded
  once, bots never heard, a refusal to start with nobody allowlisted, and
  the shared `slackSenderAllowed` rule (`*` only with a pinned channel
  list, never for DMs).
- **providers-moonshot.test.ts / providers-anthropic.test.ts /
  providers-claude-sdk.test.ts** — the API providers against mocked fetch / a
  mocked SDK module (never a subprocess): request shape, retry/backoff,
  timeouts, env-binding, no key leakage; `CLOUD_HARNESSES` contains exactly
  the fetch-only harnesses. The anthropic file adds the v0.12 behaviors:
  server-side web search spends exactly the granted budget (no budget → no
  tools array at all), `pause_turn` continuation keeps pre-pause text, a
  tool-refusing gateway degrades honestly instead of failing the run,
  thinking-only responses retry once with thinking disabled, and 429 / HTML
  block pages are diagnosed by name (shared-window vs. request-shape).
- **store-github.test.ts** — the remote store against a scripted GitHub API
  with an in-test fixture tarball: read-your-writes, one commit per flush,
  `force:false` + exactly one conflict retry, User-Agent on every call, and
  a full `runAgent` over the store landing report + 3 ledger lines in ONE
  commit. (`store-github-integration.test.ts` hits a real repo branch, gated
  on `GITHUB_STORE_IT=1`.)
- **workers-alarm-time.test.ts / workers-imports.test.ts** — DST-correct
  alarm math across both US transitions; the Worker import-graph walker that
  fails on any `node:*` or subprocess module.
- **brains.test.ts** - the mesh of brains (v2.0) as behavior: config
  validation (slugs, reserved words, self/duplicate links, one parent,
  members with an owner); `share:` is deny-by-default and decided by the
  EXPORTER's relation; mandatory `markings:` win over any share and are
  conjunctive; only granted briefs and only child links get the brief and
  the constitution; linked brains are read-only (every write throws); a real
  run inlines shared concepts and never private ones; one-sided, mismatched,
  or invalid link maps read nothing; a GitHub link never borrows
  `GITHUB_TOKEN`; read-requests across a link refuse private and missing
  concepts identically; inherited gates are enforced; only owner/approver
  members decide.
- **brains-cli.test.ts** - `init --kind person` scaffolds a conformant
  personal brain; `brains` shows both directions, mutuality, and
  unresolvable `brain://` refs; `brains sync` materializes parent law (and
  `brains` flags it stale after the parent amends); `gate --by` enforces
  member roles; `validate` errors on a malformed link map.
- **google-sources.test.ts** - `redactSensitive` removes card, account,
  SSN, one-time-code, and password values and leaves ordinary text alone;
  consent scopes are exactly read-only; inbox and calendar sections are
  framed as untrusted, redacted, and honest when unconfigured or failing.
- **connect-google.test.ts** - the consent URL (read-only scopes, PKCE
  S256, offline), refusal of wider-scoped tokens, the `.env.local` upsert
  (mode 600), the full loopback flow storing the token without printing
  it, and a forged-state callback storing nothing.
- **ontology.test.ts** - concept-type schemas: opt-in per type, required /
  enum / date / list / boolean / typed-link checks, strict schemas fail
  conformance while non-strict ones warn, malformed schemas are errors; the
  ontology view's catalog, link types, and cross-brain references.

## workers/heartbeat/test/ — the Worker in real workerd

`pnpm test:worker` (included in `pnpm verify`) runs vitest inside workerd
via `@cloudflare/vitest-pool-workers`: the deployed-shape Worker with its
Durable Object, all outbound services (GitHub, Kimi, Discord, Slack) scripted with
`fetchMock` — one-shot interceptors with exact call counts, so the mock plan
IS the expected traffic (`assertNoPendingInterceptors` in every afterEach).

- **router.test.ts** — /healthz sanitization (counts only, never failure
  strings), Bearer auth on /beat, first-arm idempotence, the public card,
  404-by-default.
- **heartbeat-do.test.ts** — the alarm re-arms in `finally` even when the
  beat crashes (with the failure DM proven); alarm lands at the configured
  hour in the configured timezone; the beat mutex (fresh lock skips, stale
  lock stolen, lock cleared after).
- **beat-e2e.test.ts** — a full cloud beat end-to-end in workerd: snapshot →
  due decision → Kimi cognition → report + ledger → ONE commit (force:false,
  `animamesh-cloud`) → Discord DM; same-day dedup; an agent-level provider
  failure that the beat survives and reports; failure alerts that follow
  the brain's delivery channels (a brain moved to Slack never hears from
  Discord).
- **interactions.test.ts** — the inbound Discord door: Ed25519 signature
  checks (PING/PONG, 401 on bad or unsigned), the sender gate (a stranger
  gets silence and the attempt folds into the next drain's ONE commit), the
  daily budget gate, and the full deferred flow — defer → cognition → one
  evidence commit → followup reply, honest even when the run fails.
- **slack-events.test.ts**: the inbound Slack door (v2.3): HMAC signature
  and the five-minute replay window (checked against Slack's published test
  vector), the url_verification handshake, bots and edits dropped, the
  sender and channel gates, event_id dedup against Slack's retries, the full
  flow (👀 → channel or thread context → one evidence commit → threaded
  markdown reply, with other people's words kept out of the repo), a DM as a
  direct audience, a missing history scope degrading to no context, and the
  ephemeral budget notice.
- **direction-gmail.test.ts** — the Gmail poll cycle: unread principal mail →
  agentic run → ONE commit → reply email → mark read; a processed message id
  never runs twice; over-budget mail stays unread and unspent (eligible
  again tomorrow); the poll cadence re-arms the alarm.

`workers/web/test/web.test.ts` (`pnpm test:web`, in root verify) proves the
dashboard Worker the same way: a deny-by-default door (login page with zero
data, Google OIDC with signed state, wrong account / unverified email /
forged or tampered session all strangers), a dashboard that never mislabels
a direction artifact or a spoke report as the brief, the one action proxying
`/beat` with the server-held Bearer, and logout clearing the session.

Pinned to vitest 3.2.x + pool 0.12.x (the last vitest-3 line, matching this
suite). The 0.13+ pool requires vitest 4 and replaces defineWorkersConfig and
fetchMock — migrate deliberately with Cloudflare's shipped codemod.
Two pool quirks are handled in `test/fixtures.ts`/config comments: isolated
storage can't pop live SQLite sidecars (so tests wipe DO state explicitly
instead), and the first stub call after a module reload needs one retry.

## The golden day — `test/golden-day.test.ts` (deterministic, in verify)

P2's testing bar: one fully scripted mesh day (two spokes + the hub, frozen
clock, scripted model outputs) replayed through the real heartbeat, with
every observable asserted — due ordering (spokes → hub), three green runs,
ledger trios with frozen timestamps, the hub's prompt containing today's
spoke reports + nags + pending approvals, byte-stable report bodies modulo
runId, same-day replay = pure no-op, and the cloud view skipping
subprocess harnesses with reason. The day runs through the real prompt
assembly, so every agent's prompt carries the v0.12 capability block (the
fake harness declares nothing — all three agents are told "no web, no
files" out loud); the block's exact wording is pinned separately in
`capabilities.test.ts`. When behavior changes intentionally, update the
golden day deliberately — it is the mesh's flight recorder.

## Live seam tests — `pnpm test:live` (env-gated, skipped in verify)

`test/live-seams.test.ts` proves the real integrations from the engine
checkout — the parts mocks cannot vouch for. Source your instance's env
first, then opt into each seam with its flag:

```bash
set -a; source /path/to/your-instance/.env.local; set +a
LIVE_KIMI=1 LIVE_DISCORD=1 LIVE_AGENT=1 pnpm test:live
```

- `LIVE_KIMI=1` — one real Moonshot/Kimi completion (~seconds, ~150 tokens).
- `LIVE_DISCORD=1` — one real bot DM to the configured principal.
- `LIVE_AGENT=1` — a **full agentic run locally end to end**: temp instance
  scaffolded on disk → real Kimi cognition → report artifact + ledger +
  verifiers green. Touches no real instance; safe against daily dedup.
- `GITHUB_STORE_IT=1` — the GitHub store against a real throwaway branch
  (`store-github-integration.test.ts`).
- `LIVE_EVAL=1` — **AI-driven eval** (`live-eval.test.ts`): a REAL model
  writes the chief-of-staff brief over the golden day's scripted facts, and
  a second model call judges it against a rubric (surfaces the discrepancy?
  carries the nag? honest about quiet areas? score ≥ 6/10) — verdict JSON
  asserted in code. Two Kimi calls. Run after changing buildPrompt or any
  agent job description.

All five appear as *skipped* in `pnpm verify` — the contract suite stays
network-free; the live gates exist so "it works on mocks" is never the only
evidence. Run them after touching a provider/channel/store seam.

## Adding tests

1. New safety property ⇒ new behavioral test that proves the failure mode
   throws/fails. A gate without a test is not a gate.
2. Build fixtures with `makeTree`/`concept`/`minimalAnimaMeshFiles` from
   `helpers.ts`; clean up in `afterEach`.
3. Model interactions go through `FakeProvider` with a handler — assert on
   `fake.calls` for prompt-content expectations.
4. Real-harness behavior (claude-code/opencode) is verified against a live
   instance manually; record findings in the commit body, then encode the
   *deterministic* part as a test (see the per-cwd opencode server fix).
