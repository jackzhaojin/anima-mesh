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
   production instance de-identified, with the brain-anatomy,
   dynamic-roster, and resource-reach diagrams (start here for a talk
   or demo)
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
   runbook (two Workers, secrets contract, Discord wiring, multi-company);
   [slack.md](slack.md) puts the persona in a Slack workspace - channel
   briefs and @-mention answers, with an app manifest
9. [okf-crm-domain.md](okf-crm-domain.md) — the first front-office domain
   shelf: CRM as typed concepts, with compliance screens encoded in data
10. [local-agents.md](local-agents.md) — the third tier: compile any agent
    concept into Claude Code + opencode interactive surfaces
    (`export-local`), and the `defect-report` loop back into this repo —
    issue-first with the instance's standing PAT, deterministic at every
    trust-bearing step (gate, leak guard, dedup, ledger)
11. [layered-brains.md](layered-brains.md) - the mesh of brains (v2.0):
    person, org, team, and group brains; links declared on both sides;
    `share:` grants and `markings:` restrictions; inherited law; members and
    roles; the principal's Gmail and Calendar as redacted read-only sources
12. [ontology.md](ontology.md) - concept-type schemas, the ontology view, and
    how the bundle maps to Palantir's Ontology
13. [okf-v0.2.md](okf-v0.2.md) - OKF v0.2 (v2.2): provenance, trust tiers,
    lifecycle, staleness; **the conventions every AI session follows when it
    writes a memory file**; migrating an older brain
14. [learnings/](learnings/README.md) - hard-won platform knowledge with
    evidence; **check here first when a vendor edge misbehaves**

Upgrading, or wondering when a behavior changed? [../CHANGELOG.md](../CHANGELOG.md)
is the only place upgrade boundaries are narrated release by release —
including the issue-#4 story behind the capability contract.

Working on the code itself? [../CLAUDE.md](../CLAUDE.md) has the working
agreements and invariants; [../src/README.md](../src/README.md) the module
map; [../test/README.md](../test/README.md) the testing contract.

## Diagrams

Hand-drawn SVGs that render on GitHub; the 1280×720 ones drop straight
into a 16:9 slide.

| Diagram | Shows | Used in |
|---|---|---|
| [two-point-x.svg](two-point-x.svg) | 2.x at a glance: v2.0 to v2.3, by the numbers (16:9) | README, CHANGELOG |
| [mesh-of-brains.svg](mesh-of-brains.svg) | person, org, team, group brains; links, grants, markings (16:9) | README, layered-brains |
| [slack-in-the-room.svg](slack-in-the-room.svg) | a Slack @-mention end to end, gates to threaded reply (16:9) | slack, architecture |
| [cloud-architecture.svg](cloud-architecture.svg) | the cloud tier: people, Worker, brain, linked brains, sources | architecture |
| [heartbeat-sequence.svg](heartbeat-sequence.svg) | one beat, step by step | heartbeat-anatomy |
| [engine-and-instance.svg](engine-and-instance.svg) | the public engine vs a private brain | starting-a-company |
| [brain-anatomy.svg](brain-anatomy.svg) · [agent-roster.svg](agent-roster.svg) · [resource-reach.svg](resource-reach.svg) | one org brain in production, de-identified | a-typical-brain |
| [ai-comes-to-you.svg](ai-comes-to-you.svg) | the push posture: everything travels to the human | (talks) |
| [defect-loop.svg](defect-loop.svg) | engine defects filed from inside a run | (talks) |

## Contributing docs

- New platform lesson → `learnings/YYYY-MM-DD-<slug>.md` (conventions in
  [learnings/README.md](learnings/README.md)), linked from its index.
- Keep pages one-purpose and cross-link instead of duplicating — a fact
  stated twice will drift.
- De-identify ruthlessly: if an example needs an org, use "Acme Co"; if it
  needs a hostname, use `<worker-host>`.
