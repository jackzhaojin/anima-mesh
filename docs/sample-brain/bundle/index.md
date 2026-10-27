---
okf_version: "0.2"
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
   watch-list, [operations](ops/index.md) — and writes the daily brief,
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

## Areas

- [Organization](organization/index.md) - Identity, ownership and source-document memory.
- [CRM](crm/index.md) - Relationship rules, organizations, people and engagements.
- [Governance facts](facts/index.md) - Stable boundary anchor referenced by the constitution.
- [Decisions](decisions/index.md) - Dated, immutable choices and supersession.
- [Events](events/index.md) - Append-only history.
- [Operations](ops/index.md) - Calendar, watch-list, nags, schedule and engine feedback.
- [Agents](agents/index.md) - Roster, capabilities and required reading.

## Root anchors

- [Constitution](constitution.md) - Immutable hard limits and approval gates.
- [Update log](log.md) - Newest-first change history.

## Navigation and new memory

Memory is two tiers deep by default, three at most: an area, then a
calendar year for dated records (decisions/2026/, events/2026/) or a topic
for evergreen ones, then optionally one more level. The root maps areas,
each area maps its years or topics, and those indexes list records.
Keep descriptions beside links; each file has one canonical home. Runtime
anchors (agents, ops, events and constitution) keep their established paths.
Evergreen facts keep stable names; new dated filenames use YYYYMMDD-slug.md.
Frontmatter dates and log headings retain YYYY-MM-DD. This is an AnimaMesh
authoring convention; OKF supports other layouts too.

## Outside the bundle

- [Sample README](../README.md) - How to validate and run this fictional instance.
- `../reports/` - Agent outputs; historical records are not rewritten.
- `../drafts/` - Gated draft artifacts and preparation packs.
- `../approvals/` - Human approval records.
- `../ledger/actions.jsonl` - Append-only action evidence.
