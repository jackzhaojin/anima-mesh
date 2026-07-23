# src/ — architecture map

Read [../CLAUDE.md](../CLAUDE.md) for working agreements. This is the
module-by-module tour, in dependency order (each layer only imports from the
ones above it).

## okf/ — the knowledge layer

- `frontmatter.ts` — parse/serialize one concept file (YAML frontmatter +
  markdown body). Returns `null` for no-frontmatter files, **throws** on
  malformed YAML — silent repair would mask corruption in an organization's
  knowledge.
- `bundle.ts` — walk a bundle dir into `{root, concepts[]}`. Tolerant loader:
  parse problems are *recorded* on the concept (`missingFrontmatter`,
  `parseError`) so conformance can report them all at once.
- `conformance.ts` — the validator. Profile `okf` = reserved `index.md` +
  `log.md`, every concept parses and has a `type`. Profile `animamesh` adds:
  constitution present and `immutable: true`, decisions/events dated, agent
  concepts declare `model`/`harness`/`level`. Broken relative links are
  warnings, not errors.

## ledger/ — the audit seam

`Ledger` appends JSONL, never truncates. `integrity()` (every line parses) and
`assertRunLogged()` (every declared action appeared) are the deterministic
assertions verifiers build on.

## gates/ + autonomy/ — the safety layer

- `autonomy/ladder.ts` — L1 report → L2 +draft → L3 +whitelisted reversible →
  L4 +external. `requiresGate("external")` is `true` unconditionally: L4 never
  exempts an action from its gate.
- `gates/approvals.ts` — file-based approval records (`<id>.json`), one per
  consequential action. Decisions are terminal (no un-approving).
- `gates/gatekeeper.ts` — `assertActionAllowed` throws `GateViolation` unless
  (1) the ladder allows the category, (2) reversible actions are whitelisted,
  (3) gated types carry a *matching approved* record. Gated-type vocabulary
  loads from the constitution concept as a **union with the built-in floor** —
  a constitution can add gates, never remove them.

## agents/ + instance/ — configuration as knowledge

- `agents/concept.ts` — an agent IS its concept file: `level`, `model`,
  `harness`, `whitelist`, `commercial` in frontmatter; the job description is
  the body. `assertActivatable` enforces the commercial dual gate
  (boundary map verified AND trigger/waiver) from `animamesh.config.json`.
- `instance/config.ts` — resolve an instance root (config + bundle + ledger +
  approvals + reports + drafts paths). Shape/defaults live in `config-core.ts`
  (Workers-safe).
- **`instance/store.ts` — the storage seam.** Everything the harness touches
  at run time (`loadConfig`/`loadBundle`/reports/ledger/approvals/`flush`)
  behind one async interface, with read-your-writes semantics. Two
  implementations:
  - `store-fs.ts` — the local-directory behavior, extracted verbatim;
    `flush()` is a no-op (writes were immediate).
  - `store-github.ts` — the instance over HTTPS: one tarball snapshot at a
    pinned commit (`tar.ts`, a Workers-safe ~100-line reader), writes
    buffered in memory (full-file writes + replayable ledger appends), then
    **exactly one commit per `flush()`** via the git data API —
    `force: false`, one re-snapshot retry on a moved ref, then a loud
    failure. Committer identity `animamesh-cloud` so `git log` attributes
    the writer. `github-auth.ts` isolates token minting: GitHub App
    installation tokens (RS256 JWT via WebCrypto, cached ~55 min, loud fail
    on partial config) with a PAT path when no App var is set — the swap
    landed in v0.8 and touched only that file, as designed.

## providers/ — the chokepoint

`AgentWorkerProvider` = `{name, assertConfigured(), run(opts)}`. Everything
model-related crosses this seam and nothing else does.

- `index.ts` — the registry **core** (Workers-safe): only fetch-based
  providers imported here. Exports `CLOUD_HARNESSES` — the single definition
  of what a cloud beat may run — and `resolveProvider(harness, ctx?)`, where
  `ctx` (`ApiProviderContext`: injected env + fetchImpl) binds API providers
  to Worker secrets or an instance's `.env` files.
- `moonshot-api.ts` — OpenAI-compatible chat completions by pure fetch.
  `MOONSHOT_BASE_URL` overrides the endpoint (subscription keys are
  endpoint-scoped); 429/5xx backoff; no `temperature` (some models
  hard-reject non-defaults); tokens surfaced to the ledger.
- `anthropic-api.ts` — Claude Messages API by pure fetch on a subscription
  OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`): Workers-capable Claude cognition,
  no SDK, no subprocess, no metered key. **The system prompt shape is
  load-bearing**: identity sentence as its own first block, or the gateway
  rejects large requests (docs/learnings/2026-07-12). Error paths
  distinguish quota 429s (window status + reset time appended) from
  request-shape 429s, and name HTML block pages instead of spraying markup.
- `node-providers.ts` — the subprocess providers, registered as an import
  side effect by Node entrypoints only (never by `workers/`):
  - `claude-code.ts` — spawns `claude -p … --output-format text`.
  - `claude-agent-sdk.ts` — Claude via `@anthropic-ai/claude-agent-sdk`
    (lazy import; subscription auth via `CLAUDE_CODE_OAUTH_TOKEN`; read-only
    tools, no settings bleed). Laptop-only by architecture: the SDK spawns a
    bundled CLI.
  - `opencode.ts` — long-lived `opencode serve` **per working directory**
    (the session's relative reads must resolve against the instance), REST
    session + message, SSE `/event` tap for live tool-firing progress.
- `fake.ts` — deterministic, records calls; the regression suite's provider.

## harness/ — one heartbeat

Core/node split throughout: the `*-core.ts` modules are Workers-safe (store
required, no filesystem); the unsuffixed modules are Node wrappers that
default the store to the local directory and register subprocess providers.

- `run-core.ts` — `runAgentCore`: load via store → find agent → activation +
  ladder checks → assemble prompt (job + inlined `index.md`/`ops/*` incl. the
  `ops/nags.md` persistent-reminder surface + latest mesh reports + pending
  approvals) → provider.run with **cwd = bundle root** (fs stores) → harness
  writes the report artifact (L1 contract: the agent causes no side effects)
  → ledger appends → verifiers → flush (`per-run` default; `caller` batches a
  whole beat into one commit). Injected `now` freezes all timestamps;
  injected `timeZone` keeps datestamps and daily dedup honest on UTC runtimes.
- `heartbeat-core.ts` — the scheduled wake: **daily = "not yet today"
  (calendar, tz-aware — a late-night manual run never eats the morning
  brief)**; weekly/monthly/quarterly are hour-thresholds under-period for
  cron drift; spokes first, hub last; **one spoke's failure never aborts the
  beat**; commercial agents skip while dual-gated; `cloudTier: true` skips
  any harness not in `CLOUD_HARNESSES`, with reason.
- `direction-core.ts` — `runDirectionCore`: the second entry point beside the
  heartbeat. An inbound principal message (Discord interaction, polled email)
  becomes ONE agentic run with full bundle context; the model decides the
  disposition itself (answer / recommend / flag / "nothing to do") — no
  keyword routing. Ledger actions are `direction-*` (never `run-*`, so a
  midday direction can't eat tomorrow's daily dedup); the artifact is
  `{date}-{agent}.direction-{runid}.md` (the dot keeps brief delivery blind
  to it); replies are cut at 1900 chars for channel limits. Sender gating
  and budgets live at the channel edge (the Worker), not here.
- `drafts.ts` — `draft-request` fenced blocks: parse → gate (level +
  `draft-write` whitelist) → path-jail to the drafts dir → write in the
  run's own flush → ledger. Model proposes, code disposes.
- `defects.ts` — `defect-report` fenced blocks: the drafts spine pointed at
  engine feedback. Parse → gate (level + `defect-report` whitelist) →
  identity-leak guard (the engine repo is PUBLIC; principal/persona
  names/emails DENY, never rewrite) → GitHub issue on `config.engine.repo`
  via `defects/report-core.ts` (label `defect`, title-dedup, 2/run cap) →
  ledger `defect-reported`/`defect-report-denied`. Credential:
  `GITHUB_DEFECTS_TOKEN` (Issues R/W PAT on the engine repo), else the
  instance's `githubToken`; none ⇒ honest ledgered denial.
- `verifiers-core.ts` / `verifiers.ts` — the three seam checks
  (+ conformance): expected outputs exist, no gated ledger entry without its
  approval, all declared actions logged, bundle still conformant. Store-aware
  variants in core; disk-fidelity wrappers for the CLI.
- Cognition routing: `effectiveCognition(agent, config)` (in `agents/`)
  applies `config.cognition.overrides` — the declared harness/model stays
  the agent's identity; the override is what actually runs, is what the
  cloud gate judges, and is what evidence records.

## channels/ + a2a/ — reaching the principal, and the world

- `channels/registry.ts` (Workers-safe) — channel registry (discord bot-DM /
  webhook, notion, gmail, console; all pure fetch with injected env) +
  `deliverLatestReportFromStore`. `channels/index.ts` adds the fs wrapper.
- `a2a/card-core.ts` — the mesh's Agent Card assembled from a loaded bundle
  (`streaming: false` — short connections by design; dual-gated commercial
  agents are not advertised). `a2a/card.ts` is the fs wrapper.

## sources/ — external READ context

The inverse of channels: document stores an agent's prompt is assembled
*from*, read-only by construction (adapters expose listing + content reads,
nothing else). Agents opt in per-concept via `sources:` frontmatter;
`run-core` inlines each declared source's section at prompt-assembly time, so
L1 runs still need no tool access. Failure posture: unconfigured or
unreachable sources become honest prompt sections ("do not guess at cabinet
contents"), never aborted runs.

- `sources/msgraph.ts` — the `onedrive` source: Microsoft Graph via OAuth
  refresh token (secret optional — device-code public clients have none),
  bounded breadth-first cabinet listing that follows Teams/SharePoint
  shortcuts (`remoteItem`) into their remote drives, and clipped text-only
  file reads. Env contract in the module header; delegated read scopes only.
- `sources/github-docs.ts` — the `github-docs` source: a git-hosted document
  repo as read context. One corpus, two access paths: GitHub REST (one
  recursive git-trees call — pure fetch, runs on Workers) or a local working
  tree when `GITHUB_DOCS_LOCAL_PATH` is set AND the harness injected the
  `SourceFs` capability (Node tier — fresher, tokenless). Env contract in
  the module header; token falls back `GITHUB_DOCS_TOKEN` → `GITHUB_TOKEN`.
- `sources/local-files.ts` — the Node `SourceFs` implementation (bounded
  deterministic walk + root-escape-proof reads). Imports node built-ins, so
  it lives OUTSIDE the Worker import graph: `run.ts`/`heartbeat.ts` inject
  it; `workers-imports.test.ts` bans it from Worker entries.
- `sources/registry.ts` — `sourceSections(names, ctx)`, the harness's one
  entry point.

## workers/ — the cloud tier (repo root, own workspaces)

`workers/heartbeat/`: a Cloudflare Worker + two Durable Objects. `HeartbeatDO`
holds the DST-correct daily alarm (`alarm-time.ts`) and beat mutex;
`runCloudBeat` = `heartbeatCore` over a `GitHubInstanceStore` with fetch-based
cognition (`CLOUD_HARNESSES`), one commit per beat, brief delivery + failure
DM ("silence must mean success"). `DirectionDO` owns the inbound side:
Ed25519-verified Discord interactions (`interactions.ts`), sender allowlist,
per-day budget, optional Gmail poll, queue + immediate alarm drain →
`runDirectionCore`, deferred replies sent only after the evidence commit.
Routes: `/healthz`, token-gated `POST /beat`, `POST /interactions`,
`/.well-known/agent-card.json`. `test/workers-imports.test.ts` walks the
import graph and fails on any `node:*` or subprocess module. Deploy config
lives in the instance repo; `wrangler.example.jsonc` here is a template.

`workers/web/`: the principal's dashboard (in-Worker Google OIDC, allowlist
re-checked per request, narrow env) — see `workers/web/README.md`.

## init/ — a brain from nothing

- `templates.ts` — locate/fill `templates/agents/*` (`{{VAR}}` substitution,
  deliberately dumb).
- `scaffold.ts` — `scaffoldBrain(emptyDir, answers)` writes config, bundle
  (index/log/constitution/facts/ops/events/agents), and operational dirs —
  then **runs conformance on its own output and throws if it fails**.
- `interview.ts` — answers from file, flags, interactive prompts, or
  `agenticEnrich` (a provider refines the answers; malformed model output
  falls back silently — model proposes, code disposes).
- Init also exports the hub's local surfaces (below) when the roster has
  one — new instances start with them in place.

## local/ — the third tier (interactive surfaces)

- `agents-core.ts` — compile an `AgentConcept` + instance identity into
  `.claude/agents/<slug>.md` (Claude Code) and `.opencode/agents/<slug>.md`
  (opencode) artifacts: SAME persona body, surface-specific frontmatter.
  The hub exports under the persona's first name; commercial agents stay
  dual-gated; artifacts are generated, never hand-edited (tune the concept,
  re-export). See `docs/local-agents.md`.
- `agents.ts` — the Node disk half (`exportLocalAgents`).

## defects/ — engine feedback

- `report-core.ts` (Workers-safe) — `defect-report` block parsing, the
  identity-leak guard, and the GitHub Issues client (UA header set — the
  Workers 403 learning; title-dedup against open `defect` issues). Harness
  wiring in `harness/defects.ts`.

## cli.ts

`main(argv) → exit code`, so tests drive it in-process. Commands:
`init · validate · run · gate · report · deliver · heartbeat · card ·
export-local · templates`.
