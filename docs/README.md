# docs/ — the operator's shelf

Documentation for running, deploying, and extending AnimaMesh — written to
be equally consumable by a human and by an AI session with no prior context.
Everything here is **engine-general**: no company, persona, or deployment
specifics (those live in each instance's own repo — see the boundary doc).

## Read in this order (new session orientation)

1. [../README.md](../README.md) — what AnimaMesh is and the design rules
2. [architecture.md](architecture.md) — the whole system on one page, with
   the cloud diagram, read-source boundary, the capability/web-search
   contract, and principal message flows
3. [heartbeat-anatomy.md](heartbeat-anatomy.md) — one beat, step by step:
   the DO alarm, the due decision, spokes-first/hub-last, and why a long
   beat fits a serverless platform (sequence diagram)
4. [engine-vs-instance.md](engine-vs-instance.md) — the sorting rule for
   where knowledge and code belong (run its checklist whenever unsure)
5. [a-typical-brain.md](a-typical-brain.md) — show-and-tell: a real
   production instance de-identified, with the brain-anatomy and
   dynamic-roster diagrams (start here for a talk or demo)
6. [sample-brain/](sample-brain/README.md) — that instance **as files**:
   a complete scrubbed brain that validates and runs credential-free
   (`pnpm cli run chief-of-staff --instance docs/sample-brain`); its
   [bundle/index.md](sample-brain/bundle/index.md) explains how every
   piece ties into the daily loop
7. [starting-a-company.md](starting-a-company.md) — empty directory → a
   mesh running a real company; opens with the two-repo topology diagram
   (what's in the engine vs. what's in your brain); the
   [brain-setup skill](../.claude/skills/brain-setup/SKILL.md) automates it
8. [deploying-cloud.md](deploying-cloud.md) — the generic Cloudflare
   runbook (two Workers, secrets contract, Discord wiring, multi-company)
9. [okf-crm-domain.md](okf-crm-domain.md) — the first front-office domain
   shelf: CRM as typed concepts, with compliance screens encoded in data
10. [local-agents.md](local-agents.md) — the third tier: compile any agent
    concept into Claude Code + opencode interactive surfaces
    (`export-local`), and the `defect-report` loop back into this repo —
    issue-first with the instance's standing PAT, deterministic at every
    trust-bearing step (gate, leak guard, dedup, ledger)
11. [learnings/](learnings/README.md) — hard-won platform knowledge with
    evidence; **check here first when a vendor edge misbehaves**

Upgrading, or wondering when a behavior changed? [../CHANGELOG.md](../CHANGELOG.md)
is the only place upgrade boundaries are narrated release by release —
including the issue-#4 story behind the capability contract.

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
