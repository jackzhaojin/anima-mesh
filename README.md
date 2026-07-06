# AnimaMesh

**The brain is private; AnimaMesh is what animates it.**

AnimaMesh is an engine for running a **company-of-0**: a mesh of small, decoupled
agents that operate a real organization's back office — compliance calendars,
bookkeeping, document librarianship, governance, research watch — coordinated by
an agentic Chief of Staff, with a **human as the only approval gate**.

*Anima* — Latin, the breath that brings a body to life. The body it animates is
your **brain repo**: a git-backed, [OKF](https://github.com/google/okf)-style
bundle of markdown concepts that is the mesh's single source of truth. The engine
is strictly data-source-agnostic: it consumes any brain supplied by
configuration and ships with an init that scaffolds one from nothing.

## The shape

```
your-brain/                      ← private instance (yours)
  animamesh.config.json          ← the pairing: paths, identity, engine pin
  bundle/                        ← OKF knowledge bundle — the ONE seam
    index.md · log.md            ← reserved files
    constitution.md              ← immutable hard limits (machine-read gates)
    facts/ decisions/ events/    ← stable / dated-immutable / append-only
    ops/calendar.md              ← what agents wake up to check
    agents/*.md                  ← each agent IS a concept file
  ledger/actions.jsonl           ← append-only action ledger (audit seam)
  approvals/                     ← file-based needs-you gate (approval seam)
  reports/ drafts/               ← run artifacts
```

**Design rules the code enforces:**

- **Agentic core, deterministic gates.** Code does exactly four jobs: heartbeat
  plumbing, constitution/gate enforcement, ledger appends, and post-run
  verifiers. Everything between wake-up and gate is model judgment.
- **The one seam.** An agent is verified only by instance state before/after a
  run — repo diff, gate assertions, ledger completeness. Internals are never a
  test surface.
- **Autonomy ladder.** L1 report-only → L2 draft-for-approval → L3 whitelisted
  reversible actions → L4 external actions, each behind a human gate,
  permanently. Every agent starts at L1; promotions live in the agent's own
  concept file.
- **The chokepoint.** Each agent concept declares its `model` and `harness`;
  swapping either is a config edit. Shipped harnesses: `claude-code` (headless
  CLI), `opencode` (any opencode-configured model — Kimi K2.6 by default), and
  `fake` (deterministic, for the regression suite).
- **Commercial capability is dual-gated.** Templates for sales-qualification /
  lead-identification / inbound-triage ship capable but will not run until the
  instance's boundary map is verified AND an explicit trigger/waiver is on file.

## Quickstart

```bash
pnpm install
pnpm verify                  # typecheck + full regression suite

# scaffold a brain (interview, flags, or answers file)
pnpm cli init ../my-brain --org "Acme Co" --principal "Ada" \
  --agents compliance-ops,chief-of-staff

# or let a model refine the interview (story: "interview me")
pnpm cli init ../my-brain --answers answers.json --agentic opencode

pnpm cli validate ../my-brain          # OKF + animamesh conformance
pnpm cli run compliance-ops --instance ../my-brain
pnpm cli gate list --instance ../my-brain
pnpm cli report --instance ../my-brain
```

The init's acceptance test is the demo: **empty directory in, conformant brain
out** — validated by the same checker the reference instance uses.

## Testing

`pnpm verify` = `tsc --noEmit` (a standing verifier) + the vitest regression
suite. The suite exercises every safety property as behavior: gated actions
without approvals throw, ladder violations throw, commercial agents without the
dual gate refuse to run, corrupt ledgers fail verification, and a scaffolded
brain must pass conformance and complete a full agent run against the fake
provider.

## References

`references/poc/` holds proof-of-concept integrations (Kimi CLI wire/print
modes, Claude Agent SDK, Codex) that informed the provider chokepoint design.
They are examples, not engine code.

## Status

v0.1.0 — pre-release. Package name on npm to be confirmed; pinned consumers
should reference the repo by tag.

MIT © Jack Jin
