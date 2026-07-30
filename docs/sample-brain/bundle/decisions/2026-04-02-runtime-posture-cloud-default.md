---
type: decision
title: "Cloud tier is the DEFAULT runtime"
status: active
date: 2026-04-02
---

# Decision: runtime posture — cloud default, laptop interim net

**Decided 2026-04-02.** The daily heartbeat's home is the cloud tier: a
scheduled worker beating over the hosted copy of this repo, committing its
reports and ledger appends back. The founder's laptop keeps a scheduled
beat only as the interim safety net, to be retired once the cloud tier has
a clean multi-week record.

Why it works: the bundle is the only state. The worker does not "sync"
with the laptop — both are just machines with the repo. Whichever tier
beats, the company's memory advances in git, and the other tier resumes
from it.

Consequences: secrets move to the worker's secret store (referenced by
variable name only, never committed); the beat's own commit is the
heartbeat's proof of life.
