# approvals/ — the human gate's records (secondary seam)

Constitution-gated actions (money, filings, publishing, credentials,
access) terminate here: the harness writes a pending approval record, the
founder disposes of it, and the matching record is what lets a gated
action proceed — ever.

```bash
pnpm cli gate list    --instance docs/sample-brain
pnpm cli gate approve <id> --instance docs/sample-brain
pnpm cli gate deny    <id> --instance docs/sample-brain
```

Empty right now: nothing is waiting on the founder, and the sample's
agents are L1/L3 — their whitelisted writes (schedule, drafts, defect
reports) are gated by code, recorded in `../ledger/actions.jsonl`, and
never need this directory.
