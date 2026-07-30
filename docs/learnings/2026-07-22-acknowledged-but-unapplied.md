# An acknowledged-but-unapplied order is the worst state

**Symptom**: the principal issues a direction ("close item N, it's resolved").
The direction run replies fluently — acknowledges the order, promises the
file edit "through the normal gate" — and never creates the gated action.
The ledger shows zero gate entries for it. The stale file then rides every
subsequent brief, because every downstream reader — the hub, the spokes, the
next brief, the principal skimming it — trusts the file, not the chat
transcript. The model even converted the order into an untracked pending
question ("flag if you want it applied as-is"), so nothing anywhere held the
obligation.

**The rule: a direction whose disposition includes a repo write must either
create the gated action in the SAME run or re-surface as its own tracked
reminder. A promise in a chat reply is not a state; only the file and the
ledger are.**

Chat is where orders arrive; the repo is where the mesh's truth lives.
Any gap between "the model said it would" and "the harness applied it or
ledgered the denial" is a place where an order silently dies — and the
better the model writes, the more convincing the acknowledgment that
nothing backs.

## Evidence (2026-07-22, live instance)

- A direction run acknowledged an ops-file close-out, promised the edit,
  produced no gate entry, and asked a follow-up question instead. The stale
  entry then led three consecutive daily briefs before a human noticed.
- Same failure class, same session: see
  [2026-07-22-beat-writes-own-commit.md](2026-07-22-beat-writes-own-commit.md)
  — an applied write that failed to land in the run's commit.

## Where the engine encodes it

- `src/harness/drafts.ts` — the draft surface was designed from this lesson:
  a `draft-request` block is applied in the run that emitted it or its denial
  is ledgered, so no acknowledged-but-unapplied state can exist on that path
  (v0.10 changelog narrates this as the motivating failure).
- `src/harness/` schedule requests follow the same contract:
  `schedule-updated` or `schedule-request-denied`, ledgered in-run.

**What remains open**: the general case — a direction disposition that
promises a *bundle concept* write (not a draft, not a schedule edit) — is
still a prose promise with no same-run apply path. Until such a path exists,
instances should teach their direction agents to route file changes through
the gated surfaces that do exist (drafts, schedule) or to state plainly that
the edit needs the principal's hand, naming the file — never to promise an
edit the run cannot perform.
