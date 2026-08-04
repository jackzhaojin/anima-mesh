# AnimaMesh

**An engine for running a company with agents — a real one, with deadlines, books, and filings — where the humans shrink to a single role: the approval gate.**

AnimaMesh operates a **company-of-0**: an organization whose entire back office
— compliance calendar, bookkeeping, document librarianship, board governance,
research watch, inbound triage — is run by a mesh of AI agents. One human
(the principal) supplies judgment and signatures. Everything else wakes up on
its own heartbeat, reads the company's knowledge, does the preparable work, and
reports back: *"here's what I found, here's the draft, approve or edit."*

The initiative inverts: **you stop driving the company's operations and start
reviewing them.** And because all company state is one **OKF knowledge
bundle** — typed markdown concepts under one validator — the mesh grows past
back office by adding *concept types*, not software: the first front-office
domain shelf is a [CRM](docs/okf-crm-domain.md) that lives in the bundle
itself.

## Where it runs

**Cloud execution is the primary operating mode.** A normal AnimaMesh instance
runs continuously on Cloudflare Workers and Durable Objects against its private,
GitHub-hosted brain. The cloud heartbeat wakes agents on schedule, commits the
run evidence, delivers the daily brief, and accepts inbound directions while the
operator's laptop is closed.

The CLI remains a first-class companion for scaffolding and validating a brain,
manual or recovery runs, local development, and subprocess-only harnesses. It is
not the production scheduler. A third surface is the **interactive tier**:
`export-local` compiles any agent concept into Claude Code and opencode agent
artifacts, so the principal can *talk to* the mesh in a coding terminal with
the exact persona the scheduled tiers run
([docs/local-agents.md](docs/local-agents.md)). AnimaMesh is also not a shared
hosted service: each private instance deploys its own Workers, Durable
Objects, repository, and secrets from this public engine.

## How it's organized

**One Chief of Staff, many detached hands.**

- **The Chief of Staff is the hub** — an agentic coordinator and the single
  communication surface. One daily brief in; routed replies and approvals out.
  It assigns, sequences, and follows up on the specialists' work by *judgment*,
  not scripts — and it holds no state, so any restart resumes from the repo and
  the hub itself is replaceable.
- **The specialist agents are detached spokes** — small, decoupled, each
  independently deployed with its own heartbeat, its own model+harness choice,
  and least-privilege credentials. The bookkeeper never holds publishing keys;
  the research watcher never sees bank data. Spokes keep working when the hub
  is down. There is no monolith coordinator, no shared work queue, no phase
  loop — coordination happens through judgment over shared state.
- **The shared state is a brain repo** — a git-backed
  [OKF](https://github.com/google/okf)-style **knowledge bundle**: one
  **concept** per file, a declared `type` in YAML frontmatter, reserved
  `index.md` and `log.md`, and relative links forming a **machine-checked
  knowledge graph** (the conformance pass verifies every link resolves).
  Facts, decisions, events, the compliance calendar, the constitution, and
  every agent's own definition are concepts; so are front-office records —
  a CRM contact is a `crm-person` concept, not a row in someone else's SaaS.
  Plain markdown: readable by any human in any editor, consumable by any
  agent on any runtime, hostage to no vendor.

The engine is strictly **data-source-agnostic**: it never references any
particular organization. Your company's knowledge is your private brain repo;
this public engine is what animates it. It ships with an init that interviews
you and scaffolds a complete, conformant brain from an empty directory.

## The shape

```
your-brain/                      ← private instance (yours, never public)
  animamesh.config.json          ← the pairing: paths, identity, engine pin
  bundle/                        ← the knowledge bundle — the ONE seam
    index.md · log.md            ← reserved files
    constitution.md              ← immutable hard limits (machine-read gates)
    facts/ decisions/ events/    ← stable / dated-immutable / append-only
    ops/calendar.md              ← what agents wake up to check
    agents/*.md                  ← each agent IS a concept file
    crm/                         ← optional domain shelf: typed CRM concepts
                                    (orgs, people, engagements, interactions)
  ledger/actions.jsonl           ← append-only action ledger (audit seam)
  approvals/                     ← file-based needs-you gate (approval seam)
  reports/ drafts/               ← run artifacts
  cloud/                         ← this instance's Worker deploy config
```

## OKF is the data model — domains extend by type, not by code

Everything an instance knows is a **concept**; every concept declares a
**type**; the **conformance pass** (`pnpm cli validate`, profiles `okf` and
`animamesh`) enforces the shape — reserved files present, frontmatter
parseable, `type` declared, agent concepts carrying their chokepoint fields,
and the relative-link **knowledge graph resolving**. The checker is
deliberately type-agnostic beyond that: a new operational domain is a folder
of new concept types under the same validator, and every agent can read it
the moment it exists — no schema migration, no plugin, no vendor API.

**The first domain shelf is CRM** ([docs/okf-crm-domain.md](docs/okf-crm-domain.md)):
`crm-org`, `crm-person`, `crm-engagement`, and append-only `crm-interaction`
concepts, with relationship-first lifecycle stages and — the part no SaaS CRM
offers — **compliance screens encoded in the records themselves**, so agents
enforce an instance's legal boundaries as data rules rather than remembered
policy. It was promoted from a live instance, de-identified; the pattern
generalizes to any relationship-shaped domain (vendors, candidates, press).

## Design rules the code enforces

- **Nothing consequential happens without a human.** Money movement, government
  filings, external publishing, credential exposure, and access expansion are
  constitutionally gated — enforced in the harness (code), never merely
  requested in a prompt.
- **Agentic core, deterministic gates.** Deterministic code does exactly four
  jobs: heartbeat plumbing, gate enforcement, ledger appends, and post-run
  verifiers. Everything between wake-up and gate is model judgment.
- **The one seam.** An agent is verified only by instance state before/after a
  run — repo diff, gate assertions, ledger completeness. Agent internals are
  never a test surface.
- **The autonomy ladder.** L1 report-only → L2 draft-for-approval → L3
  whitelisted reversible actions → L4 external actions, each behind a human
  gate, permanently. Every agent starts at L1 and earns promotion; the level is
  recorded in the agent's own concept file, so trust is an operational dial
  with a paper trail. Three L3 write paths ship today, all propose/dispose
  (a fenced block in the run's output, applied only through the gate,
  always ledgered): `schedule-update` (wake an agent for the next beat),
  `draft-write` (create/update artifacts under `drafts/` — session
  prep, outlines, quiz sheets — path-jailed, from beat AND direction runs,
  so the principal can reshape prep material by replying in chat), and
  `defect-report` (file a de-identified engine bug as a public GitHub
  issue — identity-leak guard, title dedup, and per-run cap are
  deterministic code; the model only writes the report).
- **The model chokepoint.** Each agent concept declares its `model` and
  `harness`; swapping vendors is a config edit, never a rebuild. Shipped
  harnesses: `moonshot-api` and `anthropic-api` (pure fetch — the two a cloud
  beat may run), `claude-code` (headless CLI), `claude-agent-sdk`
  (subprocess, laptop-tier by architecture), `opencode` (any
  opencode-configured model), `fake` (deterministic, for the regression
  suite). An instance can redirect a declared harness at runtime via
  `animamesh.config.json → cognition.overrides` — vendor trouble becomes a
  config edit, with the agent's declared identity untouched. Providers also
  **declare their capabilities** (file reads, web search), and the prompt
  states them to the agent — explicitly overriding the job description,
  because job text is written once while harnesses change per override.
  `web: <n>` frontmatter budgets web searches per run; `anthropic-api`
  grants them via Anthropic's server-side web-search tool in the same
  Messages call, Workers-safe. A refused budget is stated out loud in the
  prompt — silent empty research is not a reachable state. The same
  contract covers knowledge: `reads:` frontmatter declares the concept
  files a role requires, and the harness inlines them every run — or says
  `EMPTY` / `NOT AVAILABLE` in the prompt — so no-tool harnesses never run
  blind on files the job text names.
- **Cloud-first execution, one engine.** The primary runtime is a
  **Cloudflare Worker + Durable Object alarm** (`workers/heartbeat/`) over a
  GitHub-hosted brain. The laptop CLI runs the same heartbeat over a local
  directory for bootstrap, diagnostics, manual work, and subprocess-only
  harnesses; the `InstanceStore` seam swaps the transport. A cloud beat reads
  the instance as one tarball and lands all its artifacts as **one commit**
  (never force-pushed), so the repo stays the single test seam either way. No
  containers, no long-lived connections: the agent card says
  `streaming: false` on purpose.
- **Commercial capability is dual-gated.** Sales/lead/inbound-triage templates
  ship capable but refuse to run until the instance's legal boundary map is
  verified AND an explicit trigger or waiver is on file. Capability never
  outruns permission.
- **The mesh reaches its principal, and nags on request.** Delivery channels
  (Discord webhook/bot-DM, Notion, Gmail, console) carry the hub's brief; an
  optional `ops/nags.md` rides in every prompt so opted-into reminders repeat
  every heartbeat — with age — until done. Heartbeats are resilient (a failed
  spoke never kills the beat) and daily means *daily*: local-calendar
  semantics, immune to odd-hour manual runs. A due agent the cloud *cannot*
  run (subprocess-tier harness) is never a silent skip: the hub's prompt
  carries a scheduler note and the brief nags for the manual run owed.
- **The principal reaches the mesh, too — agentically.** A **direction** is
  the second entry point beside the heartbeat: an inbound message (Discord
  slash command via Ed25519-verified interactions, or a polled Gmail inbox)
  becomes one agentic run — the model reads the message with full bundle
  context and decides the disposition itself; no keyword routing exists.
  Directions are sender-allowlisted and budget-capped at the channel edge,
  ledgered as `direction-*` actions, and reply only **after** the evidence
  commit lands. A separate `workers/web` Worker gives the principal a
  Google-OIDC dashboard (allowlist-only, nothing served unauthenticated).

## Quickstart: bootstrap locally, operate in cloud

Use the engine checkout to create and validate the private brain. These CLI
commands are the setup and operator path; scheduled production execution comes
from the per-instance cloud deployment that follows.

```bash
pnpm install
pnpm verify                  # typecheck + full regression suite

# scaffold a brain (interview, flags, or answers file)
pnpm cli init ../my-brain --org "Acme Co" --principal "Ada" \
  --agents compliance-ops,chief-of-staff

# or let a model refine the interview
pnpm cli init ../my-brain --answers answers.json --agentic opencode

# no model credentials yet? add --harness fake: the deterministic provider
# runs the full loop (prompt → report → ledger → verifiers) offline, so you
# can see a complete agent run before wiring any vendor. Switch later by
# editing model/harness frontmatter in bundle/agents/*.md.
pnpm cli init ../my-brain --org "Acme Co" --principal "Ada" \
  --agents compliance-ops,chief-of-staff --harness fake

pnpm cli validate ../my-brain          # OKF + animamesh conformance
pnpm cli run compliance-ops --instance ../my-brain
pnpm cli run some-agent --instance github:owner/brain#branch   # zero local reads
pnpm cli heartbeat --instance ../my-brain      # run everything due; hub last
pnpm cli deliver --instance ../my-brain        # brief → discord/notion/gmail/console
pnpm cli card --instance ../my-brain           # the mesh's A2A agent card
pnpm cli gate list --instance ../my-brain
pnpm cli report --instance ../my-brain
```

The init's acceptance test is its demo: **empty directory in, conformant brain
out** — checked by the same validator every instance is checked by.

Prefer to see a brain already filled in and working? [docs/sample-brain/](docs/sample-brain/README.md)
is a complete scrubbed production instance — validate it, run it
credential-free, and copy its shapes into your own.

Next, push the brain to a private GitHub repository and follow
[Deploying the cloud tier](docs/deploying-cloud.md). That is the normal
always-on runtime: one Worker for heartbeats and directions, an optional
separately credentialed dashboard Worker, and one evidence commit per run.

## Documentation map

| Where | What |
|---|---|
| [docs/](docs/README.md) | **The operator's shelf — start here**, with a read order for new sessions |
| [docs/architecture.md](docs/architecture.md) | The whole system on one page: cloud diagram, Discord flows, design constraints |
| [docs/heartbeat-anatomy.md](docs/heartbeat-anatomy.md) | One beat, step by step: the DO alarm, the due decision, spokes-first/hub-last |
| [docs/a-typical-brain.md](docs/a-typical-brain.md) | Show-and-tell: a real production instance, de-identified — start here for a demo |
| [docs/sample-brain/](docs/sample-brain/README.md) | That instance as files: a complete scrubbed brain that validates and runs credential-free |
| [docs/starting-a-company.md](docs/starting-a-company.md) | Empty directory → a mesh running a real company (repeatable for company #2, #3, …) |
| [docs/deploying-cloud.md](docs/deploying-cloud.md) | Generic Cloudflare runbook: two Workers, secrets contract, Discord wiring |
| [docs/local-agents.md](docs/local-agents.md) | The interactive tier: `export-local` agent artifacts + the `defect-report` loop |
| [CHANGELOG.md](CHANGELOG.md) | Each minor release line: its value, maturity, and operator upgrade steps |
| [docs/engine-vs-instance.md](docs/engine-vs-instance.md) | The sorting rule: what belongs in this public engine vs a private brain |
| [docs/okf-crm-domain.md](docs/okf-crm-domain.md) | The CRM domain shelf: typed concepts, lifecycle stages, compliance screens as data |
| [docs/learnings/](docs/learnings/README.md) | Hard-won platform knowledge (vendor gateways, Workers egress, …) with evidence |
| [CLAUDE.md](CLAUDE.md) | Working agreements for AI coding sessions in this repo |
| [src/README.md](src/README.md) | Module-by-module architecture map |
| [templates/README.md](templates/README.md) | The agent roster templates and their placeholder contract |
| [test/README.md](test/README.md) | What the regression suite guarantees and how to extend it |
| [workers/heartbeat/README.md](workers/heartbeat/README.md) | The cloud-tier heartbeat + direction Worker and how instances deploy it |
| [workers/web/README.md](workers/web/README.md) | The principal's dashboard Worker (Google OIDC, allowlist-only) |
| [references/README.md](references/README.md) | Proof-of-concept integrations that informed the design |

## Testing

`pnpm verify` = `tsc --noEmit` (a standing verifier) + the vitest regression
suite. Safety properties are tested as *behavior*: gated actions without
approvals throw, ladder violations throw, ungated commercial agents refuse to
run, corrupt ledgers fail verification, and every scaffolded brain must pass
conformance and complete a full agent run against the fake provider.

## Status

v0.17.0 — pre-release. Package name on npm to be confirmed; pinned consumers
should reference the repo by tag. The cloud tier introduced in v0.3 is the
primary execution path; the CLI remains the bootstrap, operator, and
subprocess-harness path. The recent lines extend one theme — **nothing the
mesh cannot do is ever silent**: v0.13 added role-declared required reading
(`reads:` frontmatter inlined every run, absences stated in the prompt —
closed the mesh's own issues #5/#6, filed by its hub through the defect
loop); v0.14 made due-but-cloud-unrunnable agents first-class (the hub's
brief nags for the manual run owed instead of a journal-only skip); v0.15
streamed all `anthropic-api` cognition, removing the ~100s edge-timeout
ceiling (HTTP 524) that non-streaming calls silently imposed on long
generations; v0.16 put the bundle's append-only `events/` stream in front
of every agent every run (newest first, count out loud) — a settled fact
recorded as an event can no longer be invisibly re-litigated by the
scheduled tier; v0.17 added ask-driven retrieval (`read-request`): the
model names the files THIS run is about from a live listing — PDFs
included — and deterministic code serves them for one continuation run,
because no inline heuristic can know what the question needs. Before that: v0.12 capability truth + real server-side web
search on Workers; v0.11 the interactive tier (`export-local`) and the
`defect-report` loop; v0.10 the draft surface; v0.9 the schedule surface;
v0.8 GitHub App auth and the guaranteed failure DM. See
[CHANGELOG.md](CHANGELOG.md) for the value and upgrade boundary of each minor
line, and [docs/learnings/](docs/learnings/README.md) for evidence-backed
platform lessons.

Apache-2.0 © 2026 Jack Jin — see [LICENSE](LICENSE)
