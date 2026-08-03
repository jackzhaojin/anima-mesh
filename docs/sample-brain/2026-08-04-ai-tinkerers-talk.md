# AnimaMesh @ AI Tinkerers — 2026-08-04

**A company of zero: markdown files, a heartbeat, and an agent mesh that
runs a real business.** This page is the talk — diagram, then the code
behind it, seven times. **100% of the code is open source** — the entire
engine is this public Apache-2.0 repo; the only private thing is the
company's *data* (its brain, which is markdown, not code). Every link is
in this repo; the running production instance is private, so the code
stops here are [sample-brain](README.md), a scrubbed copy of it that
validates and runs.

---

## 1 · A company is two repos

![Engine and instance — the two-repo topology](../engine-and-instance.svg)

*Themes:* the public **engine** (this repo) holds every mechanism; a
private **brain** holds everything that makes it one particular company.
The dependency is one-way — the brain pins the engine by tag; the engine
never knows the company exists. And the roster is the company's choice:
agents are data in the brain, picked from shipped archetypes or written
fresh — we'll come back to that at stop 5.

*Code:*

- [animamesh.config.json](animamesh.config.json) — the pin (`engine.ref`),
  the identity, the activation gates. The whole coupling is this file.
- [bundle/index.md](bundle/index.md) — the brain's own map: "How a day
  works" in six steps.

## 2 · The brain is markdown — OKF, one concept per file

![Anatomy of a brain](../brain-anatomy.svg)

*Themes:* the bundle follows **OKF**: one concept per markdown file, YAML
frontmatter with a required `type`, two reserved files (`index.md` the
map, `log.md` the story). Why we chose it: the same file is equally
legible to a human, an agent, and a validator — no database, no admin UI,
no export problem; one concept per file makes every git diff a meaningful
unit of change; and typed frontmatter makes the whole brain
machine-checkable (`pnpm cli validate`) without giving up prose. Restart
anywhere; resume from git.

*Code (have these open in tabs):*

- [bundle/constitution.md](bundle/constitution.md) — immutable hard
  limits; enforced by harness code, not by asking nicely.
- [bundle/agents/chief-of-staff.md](bundle/agents/chief-of-staff.md) — an
  agent IS a file: level, model, harness, whitelist, web budget in
  frontmatter; the job in prose.
- [bundle/ops/nags.md](bundle/ops/nags.md) — "bug me daily until I do
  this," as data. Day counts and done-conditions.

## 3 · One beat, end to end

![One heartbeat, step by step](../heartbeat-sequence.svg)

*Themes:* agents are decoupled the way human coworkers are — each works
its own tasks on its own rhythm, nobody blocks anybody — but they share
one workspace: the repo. Once a day, every due agent gets ONE prompt —
job + bundle + fresh reports + what its runtime actually grants — writes
one report, and the repo diff is the audit. Everything is mediated by
files, which is exactly what puts the human in the loop at **fractional
time**: the founder spends minutes a day disposing (writes are propose →
dispose — a fenced block in the report, a whitelist gate in code, a
ledger line), not hours supervising. It runs on the cloud by default, and
the same brain runs on a laptop — the bundle is the only state.

*Code:*

- [../../src/harness/run-core.ts](../../src/harness/run-core.ts) — prompt
  assembly, capability truth, the verifiers.
- [reports/2026-07-21-chief-of-staff-3f8a2c1d.md](reports/2026-07-21-chief-of-staff-3f8a2c1d.md)
  — a daily brief, ending in a live `schedule-request` block…
- [ledger/actions.jsonl](ledger/actions.jsonl) — …and the ledger lines
  where the harness applied and consumed it.
- [../../src/harness/schedule.ts](../../src/harness/schedule.ts) — the
  gate that decides: model judgment asks, deterministic code disposes.

## 4 · Reach: files, mail, and other repos

![Resource reach — the brain goes to where the company's truth already lives](../resource-reach.svg)

*Themes:* AI memory and human memory are more alike than different — you
don't remember every line of a tax return from years past, you remember
**where you put it**. The brain is no different: the cabinet records
where truth lives and what it means, never a copy (the EIN stays in the
letter). So the company's resources never move — the brain goes to them:
documents stay in SharePoint/OneDrive, read **over Microsoft Graph**,
read-only, the live folder listing inlined into every prompt. Graph now
reads the mailbox too — the CRM was **bootstrapped from sent items**
(one-off `Mail.Read` device consent, token never persisted), because
your outbox is the ground truth of your real relationships. And the mesh
isn't confined to its own repo: the cloud tier runs the brain straight
from GitHub, reads sibling repos as sources, and commits its beats back
(what happens when the engine itself misbehaves gets its own stop — #6).
Deliberately absent: direct bank access — designed, not wired; money
stays behind constitution gates. (Workers/Durable-Object internals:
[cloud-architecture.svg](../cloud-architecture.svg).)

*Code:*

- [../../src/sources/msgraph.ts](../../src/sources/msgraph.ts) — the Graph
  read; [cabinet/2025-09-22-ein-letter.md](bundle/cabinet/2025-09-22-ein-letter.md)
  — the discipline it enables: record where truth lives, not a copy.
- [../../src/sources/github-docs.ts](../../src/sources/github-docs.ts) —
  a second repo as a read source (local tree on a laptop, GitHub API on
  Workers).
- [bundle/crm/taxonomy.md](bundle/crm/taxonomy.md) +
  [bundle/crm/engagements/2026-harborlight-content-audit.md](bundle/crm/engagements/2026-harborlight-content-audit.md)
  — the CRM the sent-mail sweep feeds: typed concepts, boundary screens
  in the data, hub proposes / founder disposes.

## 5 · One engine, many companies

![The agent roster](../agent-roster.svg)

*Themes:* everything you've just seen is generic — a second company is a
new private repo, not a fork. Scaffold it, choose its roster (the choice
from stop 1: nine shipped archetypes, or write your own agent as one
markdown file), pin the engine by tag, upgrade deliberately. The same
validator checks a hand-built brain and the scaffolder's output. And it
runs with zero credentials — the fake provider does the whole loop
offline.

*Code:*

- [../../templates/agents/](../../templates/agents/) — the archetypes.
- [../../src/okf/conformance.ts](../../src/okf/conformance.ts) — the
  conformance rules (reserved files, typed concepts, immutable
  constitution, machine-read schedule).
- Run it, live or at home:

```bash
pnpm cli validate docs/sample-brain
pnpm cli run chief-of-staff --instance docs/sample-brain
```

- [../starting-a-company.md](../starting-a-company.md) — empty directory →
  a mesh running a real company.

## 6 · The brain debugs its own engine

![The defect loop — the brain opens issues on its own engine](../defect-loop.svg)

*Themes:* the two-repo dependency is one-way, and that's load-bearing
here: **the brain can't change the engine — it can only use it.** So
anything an agent notices mid-run — a defect, or an enhancement it has
no way to make itself — has exactly one path upstream: **file an issue,
to be looked at later.** Judgment notices; deterministic code decides
what may leave — whitelist gate, identity-leak guard (the hard stop:
firm, founder, persona, or bundle strings never leave), title dedup
against open issues, a per-run cap, a ledger line. Clean reports file
directly, no draft kept; anything that can't file falls back to a
private draft. Then the flywheel closes: the fix ships, the engine tags
a release, every brain re-pins by tag — every company running the
engine inherits the fix. The exhibits are live: [issue #4](https://github.com/jackzhaojin/anima-mesh/issues/4)
(the phantom web tool) became the v0.12 capability-truth release;
[#5](https://github.com/jackzhaojin/anima-mesh/issues/5) is being fixed
right now; [#6](https://github.com/jackzhaojin/anima-mesh/issues/6) was
filed by the cloud beat this week, unprompted. The agent is user #1 of
its own bug tracker.

*Code:*

- [../../src/harness/defects.ts](../../src/harness/defects.ts) — the
  whole trust pipeline in one module: gate, leak guard, dedup, cap,
  ledger, fallback.
- [bundle/decisions/2026-06-08-defects-file-as-issues.md](bundle/decisions/2026-06-08-defects-file-as-issues.md)
  — the trust decision as a bundle concept: drafts-first until the leak
  guard earned issue-first.
- [drafts/defects/README.md](drafts/defects/README.md) — the fallback
  directory, empty in the healthy state.
- [The live issue tracker](https://github.com/jackzhaojin/anima-mesh/issues?q=is%3Aissue)
  — agent-filed issues among the human ones; see for yourself.

## 7 · The AI comes to you — not you to the AI

![AI comes to you — the mesh's push posture](../ai-comes-to-you.svg)

*Themes:* in a company of zero the scarce resource isn't compute — it's
**founder attention**. Most tooling is pull: dashboards to open, backlogs
to groom, statuses to go check — every one taxes the human to hold state
and remember to look. The mesh inverts the direction of travel: everything
it does terminates in a channel the human already lives in. The daily
brief arrives as a bot DM; a failed beat sends its **own** DM, so silence
is never ambiguous; a nag re-arrives every morning with its day count
until its done-condition is met; due work the cloud tier *can't* run
becomes an explicit ask for the manual run it's owed; and even the
engine's maintainer gets work brought to them — as issues in their queue
(stop 6's pipeline). And it never arrives empty-handed: the **prep pack**
pattern means the ask shows up with the work already started — a
paste-ready session starter, the pre-work done, forced-choice quiz
questions — so responding takes judgment, not context reloading. The
machine holds the calendar, the state, and the day counts; the human
holds only the decisions. That's what makes fractional-time founding
arithmetic work: minutes a day, because the minutes start prepared.

*Code:*

- [../../src/harness/heartbeat-core.ts](../../src/harness/heartbeat-core.ts)
  — one beat computes who's due AND what the principal is owed: brief
  delivery, the guaranteed failure DM, due-but-tier-blocked nag notes.
- [../../src/channels/discord.ts](../../src/channels/discord.ts) — the
  brief as a bot DM, chunked and rate-limit-paced. There is no dashboard.
- [drafts/nag-prep/01-bank-export.md](drafts/nag-prep/01-bank-export.md)
  — an ask arriving prepared: session starter, pre-work, quiz me — kept
  current by the hub itself via `draft-request`.

---

*Everything in this sample is fictional (Copperline Labs and its people do
not exist); the structure is scrubbed from a production brain that has run
a real company since March 2026.*
