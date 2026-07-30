---
type: index
title: "Copperline Labs — brain bundle index"
date: 2026-03-10
---

# Brain bundle — index

The single source of truth for Copperline Labs, Inc. — every agent in the
mesh reads this bundle, and everything an agent knows or decides flows back
into it. One concept per file, `type` required in frontmatter, this index and
[log.md](log.md) reserved.

*(This is the engine's scrubbed sample instance: structure production-real,
every name and number fictional.)*

## How a day works

The whole system is this loop:

1. **The beat fires** — a scheduled worker (cloud tier, daily) or a laptop
   cron. It reads `ops/schedule.md` plus the ledger to decide who is due.
2. **Each due agent gets one prompt**: its job, the operating rules, a
   statement of what this runtime actually grants (file reads, web search
   budget — the *capability truth*, which overrides the job description),
   excerpts of this bundle, the freshest reports, and pending approvals.
3. **The agent writes one report** into `../reports/`. At L1 that is all it
   can do — the report *is* the action, and the repo diff is the test seam.
4. **The hub reads everything** — every spoke report, the calendar, the
   watch-list, [ops/nags.md](ops/nags.md) — and writes the daily brief,
   nags first. The founder reads one thing.
5. **Writes are propose → dispose.** An L3 agent ends its report with a
   fenced request block (`schedule-request`, `draft-request`,
   `defect-report`). The harness — deterministic code, not the model —
   checks it against the agent's whitelist, applies or refuses it, and
   appends the outcome to `../ledger/actions.jsonl`.
6. **History only accretes.** Decisions and events are dated and immutable;
   [log.md](log.md) is append-only; course changes are new files that
   supersede old ones.

Why this holds together: **the bundle is the only state** (any machine with
the repo resumes the company — that is what makes the cloud tier possible),
**trust is code while judgment is model** (routing and prioritization are
the agent's; gates, whitelists, ledger, and leak guard are harness code),
and **the engine is pinned one-way** (`animamesh.config.json` names an
engine tag; the public engine never knows this firm exists).

## Governance

| Concept | What it holds |
|---|---|
| [constitution.md](constitution.md) | Immutable hard limits; gated action types; autonomy ladder. **Agents may not modify.** |

## Facts (stable; verify before trusting `unverified`)

Stable corporate facts come from these concepts, never model recall. A fact
marked `status: unverified` must not be relied on for a filing — the
librarian verifies against cabinet originals.

| Concept | What it holds |
|---|---|
| [facts/corporate-identity.md](facts/corporate-identity.md) | Legal entity, incorporation, EIN pointer |
| [facts/capital-structure.md](facts/capital-structure.md) | Founding capital events — **pending bank reconciliation** |
| [facts/founder-boundary.md](facts/founder-boundary.md) | Day-job constraints every agent job is checked against |

## Decisions (dated, immutable once made)

| Concept | What it holds |
|---|---|
| [decisions/2026-03-14-persona-channels-email-discord.md](decisions/2026-03-14-persona-channels-email-discord.md) | Mira runs on her own email + Discord (supersedes the custom-domain-mail plan) |
| [decisions/2026-04-02-runtime-posture-cloud-default.md](decisions/2026-04-02-runtime-posture-cloud-default.md) | Cloud is the DEFAULT runtime; laptop is the interim net |
| [decisions/2026-06-08-defects-file-as-issues.md](decisions/2026-06-08-defects-file-as-issues.md) | Engine defects file straight as public issues; drafts only as fallback |

## Events (append-only)

| Concept | What it holds |
|---|---|
| [events/2026-03-10-program-start.md](events/2026-03-10-program-start.md) | Repos created; bundle scaffolded; roster instantiated at L1 |
| [events/2026-03-18-librarian-first-pass.md](events/2026-03-18-librarian-first-pass.md) | Cabinet cataloged; the share-count correction |

## Cabinet (document memory)

One concept per key document: extracted facts + why it matters. **Originals
never enter this repo** — they stay in the founder's document store; only
knowledge comes in.

| Concept | The memory it holds |
|---|---|
| [cabinet/2025-09-15-certificate-of-incorporation.md](cabinet/2025-09-15-certificate-of-incorporation.md) | Birth certificate; 8,000,000 authorized @ $0.0001 |
| [cabinet/2025-09-22-ein-letter.md](cabinet/2025-09-22-ein-letter.md) | The EIN letter — and why the EIN is deliberately *not* recorded here |
| [cabinet/bank-statements-fy2026.md](cabinet/bank-statements-fy2026.md) | Bookkeeping raw material; ⚠ export gap = nag #1 |

## CRM (system of record)

Records are concepts: `crm-org`, `crm-person`, `crm-engagement`. Binding
rules in [crm/taxonomy.md](crm/taxonomy.md) — the employment boundary is
enforced **in the data**. The hub stewards hygiene every brief but proposes,
never writes; the founder sends everything under their own name.

| Concept | What it holds |
|---|---|
| [crm/orgs/harborlight-media.md](crm/orgs/harborlight-media.md) | The first prospective client org |
| [crm/people/sam-tran.md](crm/people/sam-tran.md) | Warm contact — head of product at Harborlight |
| [crm/engagements/2026-harborlight-content-audit.md](crm/engagements/2026-harborlight-content-audit.md) | The live engagement: stage, next action, boundary screen |

## Ops

| Concept | What it holds |
|---|---|
| [ops/calendar.md](ops/calendar.md) | Compliance calendar — deadlines and cycles |
| [ops/watch-list.md](ops/watch-list.md) | Research-watch subjects |
| [ops/nags.md](ops/nags.md) | **Active nags** — founder-requested daily bugging until done |
| [ops/schedule.md](ops/schedule.md) | Machine-read: cadence overrides + one-shot wakes |

## Agents (roster — every agent starts L1; promotions are frontmatter edits with history)

| Concept | Level | Heartbeat |
|---|---|---|
| [agents/chief-of-staff.md](agents/chief-of-staff.md) — **Mira Solen**, the hub | L3 (`schedule-update, draft-write, defect-report`) | daily |
| [agents/compliance-ops.md](agents/compliance-ops.md) | L1 | daily |
| [agents/librarian.md](agents/librarian.md) | L1 | weekly |
| [agents/research-watch.md](agents/research-watch.md) | L1 | weekly |
| [agents/sales-qualification.md](agents/sales-qualification.md) ⛔ commercial, dual-gated | L1 | (inactive until activation) |

## Outside the bundle

Sibling directories the loop writes (paths from `animamesh.config.json`):

- `../reports/` — one markdown report per run; the spokes' output and the
  hub's input. Two curated samples are checked in.
- `../drafts/` — gated draft artifacts: `nag-prep/` packs, `defects/`
  fallback drafts.
- `../approvals/` — the human gate's records (the secondary seam).
- `../ledger/actions.jsonl` — append-only action ledger (the tertiary
  seam); an unlogged action is a verifier failure.
