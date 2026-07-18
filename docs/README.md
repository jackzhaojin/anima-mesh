# docs/ — the operator's shelf

Documentation for running, deploying, and extending AnimaMesh — written to
be equally consumable by a human and by an AI session with no prior context.
Everything here is **engine-general**: no company, persona, or deployment
specifics (those live in each instance's own repo — see the boundary doc).

## Read in this order (new session orientation)

1. [../README.md](../README.md) — what AnimaMesh is and the design rules
2. [architecture.md](architecture.md) — the whole system on one page, with
   the cloud diagram, read-source boundary, and principal message flows
3. [engine-vs-instance.md](engine-vs-instance.md) — the sorting rule for
   where knowledge and code belong (run its checklist whenever unsure)
4. [starting-a-company.md](starting-a-company.md) — empty directory → a
   mesh running a real company; opens with the two-repo topology diagram
   (what's in the engine vs. what's in your brain)
5. [deploying-cloud.md](deploying-cloud.md) — the generic Cloudflare
   runbook (two Workers, secrets contract, Discord wiring, multi-company)
6. [learnings/](learnings/README.md) — hard-won platform knowledge with
   evidence; **check here first when a vendor edge misbehaves**

Working on the code itself? [../CLAUDE.md](../CLAUDE.md) has the working
agreements and invariants; [../src/README.md](../src/README.md) the module
map; [../test/README.md](../test/README.md) the testing contract.

## Contributing docs

- New platform lesson → `learnings/YYYY-MM-DD-<slug>.md` (conventions in
  [learnings/README.md](learnings/README.md)), linked from its index.
- Keep pages one-purpose and cross-link instead of duplicating — a fact
  stated twice will drift.
- De-identify ruthlessly: if an example needs an org, use "Acme Co"; if it
  needs a hostname, use `<worker-host>`.
