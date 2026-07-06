# AnimaMesh

**An engine for running a company with agents — a real one, with deadlines, books, and filings — where the humans shrink to a single role: the approval gate.**

AnimaMesh operates a **company-of-0**: an organization whose entire back office
— compliance calendar, bookkeeping, document librarianship, board governance,
research watch, inbound triage — is run by a mesh of AI agents. One human
(the principal) supplies judgment and signatures. Everything else wakes up on
its own heartbeat, reads the company's knowledge, does the preparable work, and
reports back: *"here's what I found, here's the draft, approve or edit."*

The initiative inverts: **you stop driving the company's operations and start
reviewing them.**

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
- **The shared state is a brain repo** — a git-backed bundle of markdown
  concepts ([OKF](https://github.com/google/okf)-style: one concept per file,
  `type` in the frontmatter, reserved `index.md` and `log.md`). Facts,
  decisions, events, the compliance calendar, the constitution, and every
  agent's own definition live there as plain markdown: readable by any human in
  any editor, consumable by any agent on any runtime, hostage to no vendor.

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
  ledger/actions.jsonl           ← append-only action ledger (audit seam)
  approvals/                     ← file-based needs-you gate (approval seam)
  reports/ drafts/               ← run artifacts
```

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
  with a paper trail.
- **The model chokepoint.** Each agent concept declares its `model` and
  `harness`; swapping vendors is a config edit, never a rebuild. Shipped
  harnesses: `claude-code` (headless CLI), `opencode` (any opencode-configured
  model — Kimi K2.6 by default), `fake` (deterministic, for the regression
  suite).
- **Commercial capability is dual-gated.** Sales/lead/inbound-triage templates
  ship capable but refuse to run until the instance's legal boundary map is
  verified AND an explicit trigger or waiver is on file. Capability never
  outruns permission.
- **The mesh reaches its principal, and nags on request.** Delivery channels
  (Discord webhook/bot-DM, Notion, Gmail, console) carry the hub's brief; an
  optional `ops/nags.md` rides in every prompt so opted-into reminders repeat
  every heartbeat — with age — until done. Heartbeats are resilient (a failed
  spoke never kills the beat) and daily means *daily*: local-calendar
  semantics, immune to odd-hour manual runs.

## Quickstart

```bash
pnpm install
pnpm verify                  # typecheck + full regression suite

# scaffold a brain (interview, flags, or answers file)
pnpm cli init ../my-brain --org "Acme Co" --principal "Ada" \
  --agents compliance-ops,chief-of-staff

# or let a model refine the interview
pnpm cli init ../my-brain --answers answers.json --agentic opencode

pnpm cli validate ../my-brain          # OKF + animamesh conformance
pnpm cli run compliance-ops --instance ../my-brain
pnpm cli heartbeat --instance ../my-brain      # run everything due; hub last
pnpm cli deliver --instance ../my-brain        # brief → discord/notion/gmail/console
pnpm cli card --instance ../my-brain           # the mesh's A2A agent card
pnpm cli gate list --instance ../my-brain
pnpm cli report --instance ../my-brain
```

The init's acceptance test is its demo: **empty directory in, conformant brain
out** — checked by the same validator every instance is checked by.

## Documentation map

| Where | What |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Working agreements for AI coding sessions in this repo |
| [src/README.md](src/README.md) | Module-by-module architecture map |
| [templates/README.md](templates/README.md) | The agent roster templates and their placeholder contract |
| [test/README.md](test/README.md) | What the regression suite guarantees and how to extend it |
| [references/README.md](references/README.md) | Proof-of-concept integrations that informed the design |

## Testing

`pnpm verify` = `tsc --noEmit` (a standing verifier) + the vitest regression
suite. Safety properties are tested as *behavior*: gated actions without
approvals throw, ladder violations throw, ungated commercial agents refuse to
run, corrupt ledgers fail verification, and every scaffolded brain must pass
conformance and complete a full agent run against the fake provider.

## Status

v0.2.0 — pre-release. Package name on npm to be confirmed; pinned consumers
should reference the repo by tag.

Apache-2.0 © 2026 Jack Jin — see [LICENSE](LICENSE)
