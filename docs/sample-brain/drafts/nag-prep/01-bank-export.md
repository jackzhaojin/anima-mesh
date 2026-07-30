# Nag #1 prep pack — FY2026 bank export

*Maintained by the hub via `draft-request` (draft-write whitelist). Packs
live in `drafts/` only — the hub never writes bundle concepts.*

## Where this stands

- 2026-07-02 — Nag opened; export identified as the single blocker on
  capital reconciliation.
- 2026-07-08 — Compliance-ops confirmed the 1120 dependency chain:
  export → reconciliation → preparer decision (Aug 1) → filing (Sep 15).
- 2026-07-21 — Pack current; nothing has changed but the day count.

## Session starter

Paste to begin the work:

> Reconcile Copperline's founding capital events against the FY2026 bank
> export. Inputs: `bundle/facts/capital-structure.md` (the two events,
> both unmatched), `bundle/cabinet/bank-statements-fy2026.md` (statement
> coverage), the CSV export in the document store. Output: each capital
> event matched to a bank line or flagged, and the fact's
> `status: unverified` flipped only if both match.

## Materials

- [../../bundle/facts/capital-structure.md](../../bundle/facts/capital-structure.md) — the two events to match
- [../../bundle/cabinet/bank-statements-fy2026.md](../../bundle/cabinet/bank-statements-fy2026.md) — statement coverage + the gap
- [../../bundle/ops/calendar.md](../../bundle/ops/calendar.md) — the 1120 chain this feeds

## Pre-work (done, no founder decisions needed)

- Expected matches drafted: $25,000 deposit ~2025-09-30 (capital), $5,000
  deposit ~2025-11-12 (loan). Any third founder deposit is a surprise to
  flag, not absorb.
- Reconciliation checklist drafted into the session starter above.

## Quiz me

1. Export from the bank's own CSV download or via the bookkeeping tool's
   sync? (Own download = cleaner provenance; tool = less work.)
2. If a founder deposit shows up that no resolution covers — park the
   reconciliation and draft the ratifying resolution first, or reconcile
   around it?
3. Preparer decision: are you self-filing the 1120 if the book reconciles
   clean, or is a CPA the default regardless?

---
DM me "nag 1 prep: <ask>" to regenerate or modify this pack.
