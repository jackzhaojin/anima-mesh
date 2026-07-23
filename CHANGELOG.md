# Changelog

AnimaMesh is pre-1.0, so this history is organized by **minor release line**:
the capability boundary operators actually adopt. Patch tags are deliberately
rolled into the value and maturity of their minor rather than narrated one by
one. The latest tag is **v0.10.1**.

## Upgrade procedure

Upgrade one private instance at a time:

1. Read every minor section from the currently pinned line through the target
   line. Upgrade notes are cumulative.
2. Fetch the latest patch tag in the target line, install its locked
   dependencies, and run `pnpm verify` in the engine checkout.
3. In the private brain, update `animamesh.config.json → engine.ref`, run
   `pnpm cli validate <brain>`, and record the upgrade in the instance log.
4. From v0.3 onward, compare the instance's private `cloud/wrangler.jsonc`
   files with the target tag's `workers/*/wrangler.example.jsonc`. Merge new
   bindings, Durable Object migrations, variables, and secret names without
   replacing instance-specific values.
5. Redeploy each affected Worker. Check `GET /healthz`, trigger one
   authenticated `POST /beat`, and confirm the mesh-authored commit and brief
   delivery before considering the upgrade complete.

No release through v0.9 requires an existing bundle or ledger to be rewritten.
The ledger remains append-only; never "migrate" it by editing old entries.

## [Unreleased]

(nothing yet)

## [v0.11.x] — the third tier: local interactive surfaces + engine defect telemetry

**Latest tag: v0.11.0 · 2026-07-24**

### Value

The persona has always BEEN the concept file — v0.11 makes that pay off on
a third tier. `anima-mesh export-local` compiles any bundle agent + the
instance's identity into interactive agent artifacts for local coding
terminals, so the principal can *talk to* the mesh with the exact
personality the scheduled tiers run:

- `.claude/agents/<slug>.md` — Claude Code: `@agent-<slug>`, or the whole
  session via `claude --agent <slug>`.
- `.opencode/agents/<slug>.md` — opencode: hub = `primary` (Tab-switch),
  spokes = `subagent`; headless via `opencode run --agent <slug>`.

Both artifacts share one composed body: the concept's job verbatim plus
interactive session rules (read the live bundle first, open with a
stand-up, bundle read-only — work products under the drafts dir, gates and
ladder unchanged, no secret echoes). Tuning the persona = editing the
concept file and re-exporting; the artifacts carry a generated-file marker.
`init` runs the export automatically when the roster has a hub, so new
instances start with local surfaces in place.

And the mesh gains its first feedback loop INTO the engine:
`defect-report` fenced blocks (whitelist-gated, same propose/dispose spine
as drafts) file de-identified GitHub issues on `config.engine.repo` —
identity-leak guard (principal/persona names and emails DENY on the public
repo, never rewritten), title-dedup against open `defect` issues, 2/run
cap, `defect-reported`/`defect-report-denied` ledgered. Interactive
artifacts instruct the equivalent `gh issue create` path.

### Mechanics

- New `src/local/agents-core.ts` (+ Node `agents.ts`): compose, persona
  slug (hub exports under the persona's first name), opencode
  `provider/model` mapping, D11 dual-gate on export selection. New config
  block `localAgents { agents?, opencodeModel?, claudeModel? }`.
- New `src/defects/report-core.ts` (Workers-safe: fetch + UA header — the
  2026-07-18 Workers 403 learning) + `src/harness/defects.ts`, wired into
  beat AND direction runs; blocks stripped from chat replies; direction
  evidence lists `## Engine defects filed this run`.
- Credential order: `GITHUB_DEFECTS_TOKEN` (fine-grained PAT, Issues R/W
  on the engine repo — new optional Worker secret, see
  `wrangler.example.jsonc`) → the instance's `githubToken` → an honest
  ledgered denial naming the fix.
- CLI: `export-local [--instance dir] [--agents a,b | --all]`.
- Docs: `docs/local-agents.md`; templates ship WITHOUT `defect-report`
  (an L3-trust grant, not a default).

### Upgrade

Nothing rewrites. Optional per instance: run `export-local`, whitelist
`defect-report` on a trusted L3 agent, set `GITHUB_DEFECTS_TOKEN`.

## [v0.10.x] — the draft surface: agents prepare the principal's work

**Latest tag: v0.10.1 · 2026-07-23**

### Value

v0.10 generalizes v0.9's propose/dispose contract from schedule edits to
**artifacts**. A whitelisted agent may end any run — a scheduled beat OR a
direction (inbound chat/email) run — with fenced blocks:

    ```draft-request
    path: nag-prep/07-example.md
    ---
    <complete new file content — full replace, idempotent>
    ```

The harness parses each block, gates it through the standard
reversible-action check (ladder level + `draft-write` on the agent's
whitelist), **path-jails** it to the instance's drafts dir (no absolute
paths, no `..`, `.md` only, ≤48 KB per file, ≤4 files per run), writes it
via the storage seam so it rides the run's own flush/commit on both tiers,
and ledgers `draft-written` or `draft-request-denied`. A promised write
lands in the same run or its denial is ledgered — no
acknowledged-but-unapplied state can exist (the lesson that motivated the
feature).

What this unlocks operationally: a persona agent can maintain **prep
packs** — session-starter prompts, outlines, quiz sheets — for the
principal's open obligations, updated every beat, and the principal can
reshape them over chat: a Discord DM ("more prep on item 7, outline only")
becomes a direction run that regenerates the artifact and commits it,
with the fenced block stripped from the chat reply and the written paths
listed in the evidence report (`## Drafts written this run`).

Mechanics:

- New `src/harness/drafts.ts`: parser, jail, caps, gate-then-apply, prompt
  capability lines. Applied from both `run-core` and `direction-core`.
- Prompt advertisement is whitelist-gated (the v0.9 rule): agents whose
  gate would deny `draft-write` are never told the syntax.
- Direction runs gain their first gated write path; the direction prompt
  carves the exception explicitly ("do it in this run, confirm with the
  path").
- No store changes: `InstanceStore.writeFile` (v0.9) already carries it on
  fs and GitHub stores.
- No constitution changes: `draft-write` is reversible-tier; the
  always-human-gated floor is untouched. Drafts are non-bundle artifacts —
  reversible via git, never validated as concepts, never delivered
  externally.

### Upgrade notes

- Grant the capability per agent by adding `draft-write` to `whitelist:`
  in the agent concept (L3+). No config or bundle migration required.
- The drafts dir remains `animamesh.config.json → drafts` (default
  `drafts/`).

## [v0.9.x] — the schedule surface: the hub can schedule the follow-through

**Latest tag: v0.9.3 · 2026-07-23**

### Value

v0.9 gives the mesh a mutable scheduling surface without giving up the
deterministic scheduler. `bundle/ops/schedule.md` (`type: schedule`) layers
three knobs over frontmatter cadence, read by the due decision every beat:

- **`wake:`** — one-shot "run at the next beat", cadence regardless — even
  for agents with no `heartbeat:` at all. Consumed **on attempt**, in the
  beat's own commit, so request and fulfillment sit adjacent in git history
  and nothing double-fires. Wakes the beat *couldn't* honor (laptop-tier
  harness in a cloud beat, closed commercial gates) stay on file for the
  tier or permission state that can.
- **`pause:`** — skip until removed. Pause beats wake; the contradiction
  stays visible instead of resolving silently.
- **`cadence:`** — per-agent override of the declared `heartbeat:`
  (declared-vs-effective, the `cognition.overrides` pattern).

Next-fire time remains **derived** (cadence vs. the ledger) — the file
holds intent, never projections, so there is no second source of truth.

On top of the surface, the **gated `schedule-request` path** closes the
review→follow-through loop: any agent may end a report with a
```schedule-request``` fenced block naming agents to wake; the harness
applies it only through the standard reversible-action gate (ladder level +
`schedule-update` on the agent's whitelist), ledgers `schedule-updated` or
`schedule-request-denied`, drops self-wakes and unknown names, and never
fails the run over a denied ask. A chief-of-staff promoted to L3 with that
one whitelist entry can now review the spokes' work and wake the right
agent for tomorrow — model proposes, deterministic code disposes. The
`wake:`-then-`POST /beat` recipe doubles as the operator's manual per-agent
trigger.

Also in the line:

- `InstanceStore.writeFile` — the storage seam's concept-edit path (fs +
  GitHub stores; buffered writes overlay `loadBundle` for read-your-writes).
- Conformance A4: schedule shape errors are conformance errors (the due
  decision consumes this file in code); unknown agent names warn.
- `init` scaffolds `ops/schedule.md`; prompt assembly teaches the
  capability only to agents whose whitelist permits it.
- Docs: `heartbeat-anatomy.md` (beat walkthrough + sequence diagram),
  `a-typical-brain.md` (de-identified instance tour + roster diagram), and
  the `brain-setup` skill for standing up a new company brain.
- Docs: the **CRM domain shelf** (`docs/okf-crm-domain.md`) — the first
  front-office OKF domain: `crm-org` / `crm-person` / `crm-engagement` /
  append-only `crm-interaction` concepts, relationship-first stages,
  views-are-grep, and compliance screens encoded in record frontmatter.
  Promoted from a live instance, de-identified. No engine code was
  required: conformance is type-agnostic by design, and the R4 link rule
  already machine-checks the relationship graph.
- v0.9.3: Discord delivery chunks long reports into sequential messages
  (paragraph-boundary splits, 8-message runaway cap) instead of
  truncating at 1900 chars — webhook and bot-DM modes both.
- Docs: README rewritten to foreground the OKF vocabulary (concepts,
  types, conformance profiles, the machine-checked knowledge graph) and
  the domain-shelf extension model; `starting-a-company.md` gained the
  re-aiming (direction pivot) playbook.

### Upgrade from v0.8

- Pin to v0.9.0 and redeploy both Workers. No bundle, ledger, Durable
  Object, or dashboard migration. The schedule surface is optional — a
  brain without `ops/schedule.md` behaves exactly as before; add the file
  (copy the scaffold's) to start using wakes/pauses/overrides.
- To let a hub schedule follow-ups autonomously: promote it to L3 with
  `whitelist: ["schedule-update"]` in its concept file (a deliberate,
  git-recorded trust decision). Until then, its requests are ledgered as
  denied and surface in the report for the principal to apply by hand.
- New ledger actions (`wake-consumed`, `schedule-updated`,
  `schedule-request-denied`) are additive; nothing existing changes shape.
- v0.9.1 (found in the first live beat): a wake **renewed during the
  beat** — the hub, running last, re-waking a spoke that already ran after
  reading its report — now survives consumption; renewals are recognized
  from the beat's own `schedule-updated` ledger entries.
- v0.9.2 (issue #1, observed live 2026-07-12): a deploy or client
  disconnect mid-`POST /beat` could no longer strand the beat lock for the
  30-minute staleness window while `/healthz` served a stale lastBeat.
  The manual beat is now **detached from the request** — `POST /beat`
  returns `202 {started}` immediately and `/healthz` reports completion —
  and a lock whose isolate died is journaled as an honest failed lastBeat
  and reclaimed by the very next request (`/healthz` or trigger). The
  alarm path is unchanged. Operator-visible contract change: the trigger
  response is a run marker, not the beat summary.

## [v0.8.x] — durable GitHub auth and honest failure signals

**Latest tag: v0.8.0 · 2026-07-18**

### Value

v0.8 removes the two quietest ways the cloud tier could die or lie.

**GitHub App installation tokens** replace the PAT as the brain-repo auth
(`github-auth.ts` — the long-designed one-file swap). The engine signs a
short-lived RS256 JWT with WebCrypto, exchanges it for a ~1-hour
installation token, and caches it until near expiry. No credential with
repo write ever crosses the network long-lived, and there is no expiry
cliff: App keys rotate on the operator's schedule, zero-downtime. The PAT
path remains supported when no App var is set; a **partial** App config
fails loudly instead of falling back (a silent fallback would mask App
breakage until the PAT died). PKCS#1 keys — the format GitHub actually
downloads — are detected and rejected with the exact `openssl pkcs8`
conversion command in the error.

**Silence means success, now for spoke failures too.** Previously a beat
where *every* due agent failed delivered no brief and no DM —
indistinguishable from a quiet "nothing due" morning. Any beat with
failures now sends the principal a failure DM naming the agents, whether or
not a brief exists.

Also in the line:

- **Spend visibility**: provider usage normalizes into each run report and
  the `run-completed` ledger entry, and beats sum it into the summary —
  `/healthz` now shows tokens per beat for a mesh running on subscription
  quota.
- Bearer-gated Worker routes compare tokens in constant time
  (`crypto.subtle.timingSafeEqual`) instead of `!==`.
- `docs/deploying-cloud.md` gains the generic CI deploy shape (pipeline in
  the instance repo, engine `pnpm verify` before any deploy, a
  Workers-Scripts-only API token, sibling engine checkout).
- Cloud execution documented as the primary operating mode (docs-only
  changes previously in Unreleased).

### Upgrade from v0.7

- Pin to v0.8.0 and redeploy both Workers. No bundle, ledger, Durable
  Object, or dashboard migration; the ledger's new optional
  `detail.tokens` field on `run-completed` entries is additive.
- To adopt App auth: create a GitHub App (Contents read/write, installed on
  the brain repo only), convert its key to PKCS#8, and set
  `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY`
  on both Workers (pipe the PEM: `wrangler secret put GITHUB_APP_PRIVATE_KEY
  < app.pem`). Prove a beat, then delete the `GITHUB_TOKEN` secret so a
  broken App path can never hide behind the fallback.
- Staying on a PAT requires no change.

## [v0.7.x] — external document context that works in production

**Latest tag: v0.7.3 · 2026-07-18**

### Value

v0.7 makes a git-hosted document corpus first-class agent context. The new
`github-docs` source gives the same corpus two read-only access paths: GitHub
REST for the primary cloud runtime and a local working tree for the CLI. Agents
see a bounded, current listing without receiving write access, and failures
become honest prompt sections instead of aborted runs or guessed context.

The line also turns the source and cognition paths into production-grade cloud
behavior:

- `GET /docs/check` validates the configured corpus behind the same bearer gate
  as manual beats.
- Cloud GitHub requests carry the headers GitHub requires and surface bounded
  API error bodies, making permission and rate-limit failures diagnosable.
- The Node path can include uncommitted local documents while keeping filesystem
  code outside the Worker import graph.
- `anthropic-api` budgets for adaptive thinking and retries once with thinking
  disabled if reasoning consumes the entire output allowance, preventing a
  successful response with zero report text.

### Upgrade from v0.6

- Pin directly to v0.7.3 and redeploy the heartbeat Worker. No bundle, ledger,
  Durable Object, or dashboard migration is required.
- Existing agents remain unchanged unless they add `github-docs` to their
  `sources:` list. Instances that do not use it still benefit automatically
  from the Anthropic provider resilience fix.
- For cloud docs, add `GITHUB_DOCS_REPO` and optionally
  `GITHUB_DOCS_REF`/`GITHUB_DOCS_PATH`. Private repositories should use a
  dedicated `GITHUB_DOCS_TOKEN` with Contents read-only access; public repos
  need none. Validate through `/docs/check`.
- For local docs, set an absolute `GITHUB_DOCS_LOCAL_PATH`. Mirror ignored
  sensitive or irrelevant paths into `GITHUB_DOCS_EXCLUDE`, because a plain
  filesystem walk does not interpret `.gitignore`.

## [v0.6.x] — read-only external knowledge sources

**Latest tag: v0.6.0 · 2026-07-17**

### Value

v0.6 introduces the source seam: external document stores can be assembled into
an agent's prompt without granting the agent tools or write capability. Agents
opt in through `sources:` frontmatter; missing or unreachable context is stated
explicitly and never aborts the run.

The first adapter is `onedrive`, backed by Microsoft Graph with delegated OAuth,
bounded cabinet traversal, Teams/SharePoint shortcut support, and text-only
reads. The heartbeat Worker exposes bearer-gated `GET /graph/check` for operator
validation.

### Upgrade from v0.5

- Pin to v0.6.0 and redeploy the heartbeat Worker. Existing agents need no
  changes unless they opt into a source.
- To enable `onedrive`, add it to selected agents' `sources:` lists; configure
  the `MSGRAPH_*` vars and read-only OAuth secrets from the Worker template;
  validate with `/graph/check`.
- No bundle, ledger, Durable Object, or dashboard migration is required.

## [v0.5.x] — cloud cognition control and operational hardening

**Latest tag: v0.5.5 · 2026-07-12**

### Value

v0.5 gives cloud instances a second pure-fetch cognition path and a clean
vendor failover control. `anthropic-api` uses subscription OAuth through the
provider chokepoint, while `cognition.overrides` redirects a declared
harness/model at runtime without rewriting agent identity. Cloud eligibility,
reports, and ledger evidence all follow what actually ran.

The mature v0.5 line also captures the first production lessons: the Anthropic
OAuth system-prompt shape is enforced correctly, quota and request-shape errors
are diagnosable, browser authentication works with standards-compliant cookies,
and the dashboard reliably selects the dated hub brief rather than a README or
specialist report.

### Upgrade from v0.4

- Pin to v0.5.5 and redeploy both heartbeat and web Workers to receive the full
  provider and dashboard hardening. No data migration is required.
- `cognition.overrides` is optional; existing declarations continue unchanged.
- To use `anthropic-api`, add `CLAUDE_CODE_OAUTH_TOKEN` as a heartbeat Worker
  secret and declare or override the relevant harness. Validate with a manual
  beat.

## [v0.4.x] — the mesh becomes two-way and observable

**Latest tag: v0.4.2 · 2026-07-11**

### Value

v0.4 adds directions as the second agentic entry point. Discord interactions or
an optional Gmail poll can become a full-context run without keyword routing;
sender allowlists, daily budgets, queued execution, append-only evidence, and
evidence-before-reply ordering remain deterministic.

It also adds the separately credentialed Google-OIDC dashboard and the
workerd-local/live evaluation stack. The completed line preserves failed
direction text in the ledger, sends honest failure replies, diagnoses HTML edge
blocks, and handles concurrent GitHub snapshots without force-pushing.

### Upgrade from v0.3

- Pin to v0.4.2. Merge the `DIRECTION_DO` binding and `v2`
  `new_sqlite_classes` migration into the heartbeat Wrangler config while
  retaining the existing HeartbeatDO `v1` migration, then redeploy.
- Discord directions need `DISCORD_PUBLIC_KEY`; Gmail directions need the
  `DIRECTION_GMAIL_*` vars and `GMAIL_*`/`AGENT_EMAIL` secrets. Both surfaces
  remain optional.
- Deploy `workers/web` separately if the dashboard is desired. It receives only
  its OIDC, session, read-only GitHub, beat-trigger, and allowlist configuration—
  never cognition or persona-channel credentials.

## [v0.3.x] — the cloud execution foundation

**Latest tag: v0.3.0 · 2026-07-11**

### Value

v0.3 establishes the architecture that makes cloud the primary runtime:
`InstanceStore` separates the engine from storage, the GitHub store reads a
private brain as one snapshot and lands one non-force commit, and HeartbeatDO
provides a DST-correct daily alarm on Cloudflare Workers.

Workers-safe core modules and import-hygiene tests isolate Web Platform code
from Node wrappers. `moonshot-api` supplies fetch-based cloud cognition,
`claude-agent-sdk` remains Node-only, and the CLI can address remote brains with
`github:owner/repo#ref`.

### Upgrade from v0.2

- Pin to v0.3.0. Local-only instances need only validate; their bundle and
  ledger formats do not change.
- For cloud execution, push the brain to a private GitHub repo and create its
  private Wrangler config from the heartbeat template. Retain the HeartbeatDO
  binding and `v1` migration; set repo, timezone, and hour vars; add GitHub,
  cognition, delivery, and manual-trigger secrets; then deploy.
- Cloud-scheduled agents must use a harness in `CLOUD_HARNESSES`. Subprocess
  harnesses remain CLI-only and are skipped honestly by cloud heartbeats.

## [v0.2.x] — scheduling, delivery, and a public agent surface

**Latest tag: v0.2.0 · 2026-07-06**

### Value

v0.2 turns individual local runs into an operating rhythm: cadence-aware
heartbeats wake due specialists first and the hub last, delivery channels carry
the resulting brief through Discord, Notion, Gmail, or console, and the live A2A
agent card advertises only currently permitted capabilities.

The release also adds the `heartbeat`, `deliver`, and `card` CLI commands and
adopts Apache-2.0 licensing.

### Upgrade from v0.1

- Pin to v0.2.0 and validate the brain. There is no data migration.
- Delivery is optional. Configure `delivery.channels` and
  `delivery.deliverAgent`, then provide only the selected channels' environment
  variables in the private instance.
- This line is local-only; continue to v0.3 or later for cloud execution.

## [v0.1.x] — the safety and knowledge contract

**Latest tag: v0.1.0 · 2026-07-06**

### Value

v0.1 is the initial public engine: OKF-style concepts and conformance, agent
definitions, the L1–L4 autonomy ladder, constitutional gates, file approvals,
the append-only JSONL ledger, post-run verifiers, and the model-provider
chokepoint.

It includes the CLI for scaffold, validate, run, gates, reports, and templates;
every scaffolded brain must pass the same conformance checker used in normal
operation. Claude Code, OpenCode, and the deterministic fake harness provide the
initial local cognition options.

### Starting here

- There is no earlier tagged instance to migrate.
- Scaffold with `pnpm cli init`, validate the result, and continue through the
  later minor upgrade notes before choosing a production tag.

[Unreleased]: https://github.com/jackzhaojin/anima-mesh/compare/v0.11.0...HEAD
[v0.11.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.11.0
[v0.10.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.10.1
[v0.9.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.9.3
[v0.8.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.8.0
[v0.7.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.7.3
[v0.6.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.6.0
[v0.5.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.5.5
[v0.4.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.4.2
[v0.3.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.3.0
[v0.2.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.2.0
[v0.1.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.1.0
