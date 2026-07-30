# sample-brain — a scrubbed production instance

This folder is a complete AnimaMesh **instance** ("brain"), scrubbed from a
real one that runs a real one-person company every day. The structure, file
shapes, agent roster, and working rhythms are production-real; **every name,
number, date, and entity is fictional**. Copperline Labs, Casey Lund, Mira
Solen, Harborlight Media — none of them exist; emails use the reserved
`.example` domain. Nothing here identifies the production instance.

Two reasons it exists:

1. **Setting up your own brain.** The templates in [templates/](../../templates/)
   show empty shapes; this shows the shapes *filled in and working together* —
   what a nag looks like after three weeks, what the hub's daily brief
   actually contains, how a decision supersedes another. Copy shapes freely.
2. **Demos.** It validates and runs. You can show a full heartbeat on a
   recorded screen with zero credentials and zero private data.

## Start at the index

**[bundle/index.md](bundle/index.md)** is the map — it explains how every
piece ties into the daily loop. Read it first; everything else is texture.

## Run it

From the repo root:

```bash
pnpm cli validate docs/sample-brain          # OKF + animamesh conformance: PASS
pnpm cli run chief-of-staff --instance docs/sample-brain
pnpm cli report --instance docs/sample-brain
```

No credentials needed: the sample's config maps every declared harness to
the engine's offline `fake` provider via `cognition.overrides` — the same
knob a real brain uses to reroute around a vendor outage (declared vs
effective cognition; the run's report records both). The full loop still
runs: prompt assembly, report write, ledger append, verifiers. Delete the
`cognition` block to run on real providers and their credentials. Note a
run **writes real files** here (`reports/`, `ledger/`);
`git checkout -- docs/sample-brain` restores the curated state afterward.

## What to notice

- **The bundle is the only state.** Agents hold nothing between runs; any
  machine with the repo resumes the company. That is what makes the cloud
  tier possible at all.
- **Trust is code, judgment is model.** Routing and prioritization are the
  model's; gates, whitelists, the ledger, and the leak guard are
  deterministic harness code. Compare [bundle/constitution.md](bundle/constitution.md)
  (what may never happen) with [bundle/agents/chief-of-staff.md](bundle/agents/chief-of-staff.md)
  (what judgment is for).
- **Everything auditable is append-only** — [bundle/log.md](bundle/log.md),
  `bundle/events/`, `ledger/actions.jsonl`. History is never rewritten;
  corrections are new entries.
- **Writes are propose → dispose.** An L3 agent ends its report with a fenced
  request block; the harness applies it through a whitelist gate and ledgers
  it. See the end of
  [reports/2026-07-21-chief-of-staff-3f8a2c1d.md](reports/2026-07-21-chief-of-staff-3f8a2c1d.md).
- **Capability truth.** Each run is told what its runtime actually grants
  (file reads, web search budget) *after* its job description, and the
  runtime statement wins — an agent never has to guess whether a tool is
  missing or broken.
- **The nag discipline.** [bundle/ops/nags.md](bundle/ops/nags.md) is the
  founder saying "bug me daily until this is done" — and
  [drafts/nag-prep/](drafts/nag-prep/) is the hub keeping a ready-to-work
  prep pack per nag so the founder's next session starts warm.
- **Commercial capability is dual-gated.**
  [bundle/agents/sales-qualification.md](bundle/agents/sales-qualification.md)
  is designed capable but cannot activate until the boundary map is verified
  AND a trigger or waiver is on file — capability never outruns permission.

## Make your own

Don't copy this folder to start yours — scaffold fresh and pull shapes from
here as you need them:

```bash
pnpm cli init ../my-brain          # interactive; add --harness fake to try it credential-free
```

[docs/starting-a-company.md](../starting-a-company.md) walks the full path.
