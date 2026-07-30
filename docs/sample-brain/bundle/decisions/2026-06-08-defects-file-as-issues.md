---
type: decision
title: "Engine defects file straight as public issues"
status: active
date: 2026-06-08
supersedes: "2026-05-11 drafts-first defect posture"
---

# Decision: defect reports are issue-first

**Decided 2026-06-08.** When an agent run hits an ENGINE defect — harness,
CLI, worker mechanics, never this instance's content — the hub's
`defect-report` block files **directly as a public issue on the engine
repo**. No draft is kept for a clean report; the issue tracker is the
record.

This supersedes the drafts-first posture (every defect landed in
`drafts/defects/` for founder review before filing). Two weeks of drafts
showed the leak guard doing its job deterministically — firm names, person
names, and bundle content never survived into a draft — so founder review
was adding latency, not safety.

The trust structure that makes this safe is code, not discretion: the
whitelist gate, the identity-leak scan, title dedup against open issues,
a per-run filing cap, and the ledger entry. A report that trips the leak
guard is never filed — it falls back to a private draft in
`drafts/defects/`, exactly as before.
