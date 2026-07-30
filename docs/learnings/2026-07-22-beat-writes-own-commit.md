# Every mutable surface a beat writes must ride the beat's own commit

**Symptom**: an agent's out-of-cycle wake request is silently swallowed —
twice. The hub requests `wake: [bookkeeper]` via the gated schedule path;
the ledger shows `schedule-updated`; and the next two beats run the
bookkeeper on monthly cadence anyway, as if no wake existed. No error
appears anywhere: request, grant, and ledger entry are all present and
correct.

**The rule: every mutable surface a beat writes (schedule consumption,
reports, ledger, drafts) must land in the beat's own commit. Any wrapper
that enumerates what to stage is a second copy of that truth, and it WILL
drift the next time the engine adds a written surface.**

## Evidence (2026-07-22, live instance)

The instance's laptop-tier scheduler wrapper (a shell script run by the OS
scheduler) staged `reports/` and `ledger/` by name — written before the
v0.9.0 schedule surface existed. A beat correctly consumed a wake by writing
`wake: []` to `ops/schedule.md`, but the wrapper never staged that file, so
the consumption stayed a local uncommitted change. The daily
`pull --rebase --autostash` then carried the stale `wake: []` forward,
shadowing the committed file: the hub re-requested the wake on two
consecutive cloud runs, and two consecutive laptop beats read the stale
local copy and skipped the agent both times. A multi-day silent gap, found
only by a human noticing a dirty worktree.

The cloud tier was immune by construction: `store-github` buffers all of a
beat's writes in memory and lands them as one commit through `flush()` —
there is no enumerated staging list to go stale.

## Where the engine encodes it

- `src/instance/store-github.ts` — the cloud store's one-commit-per-flush
  contract is this rule made structural: everything the beat wrote is in
  the flush, or the flush fails loudly.
- `docs/heartbeat-anatomy.md` — the beat walkthrough states the
  one-evidence-commit contract.

**What remains open**: the engine ships no laptop-tier scheduler artifact
(launchd/cron wrapper), so instances hand-roll one — and any hand-rolled
`git add` list re-creates the enumerated-staging trap. If you must wrap the
CLI heartbeat in a scheduler script, stage the *directories the config
names* (reports, ledger, drafts, `bundle/ops/`) rather than a hardcoded
file list — or stage the whole worktree and let `.gitignore` do the
excluding. Deriving the list from `animamesh.config.json` keeps one source
of truth.
