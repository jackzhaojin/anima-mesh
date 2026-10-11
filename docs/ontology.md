# The ontology: typed concepts as a digital twin (v2.0.0)

A brain is a digital twin of whatever it models: a person's life, a company,
a team. OKF already says every concept declares a `type`. Since v2.0.0 a
type can also declare a **schema**, which turns the type word into a
contract, and the engine can show the whole brain as an ontology: types,
counts, schema coverage, the links between types, and what crosses to other
brains.

## Concept types (schemas)

A `concept-type` concept governs every concept of the type it names:

```yaml
---
type: concept-type
name: commitment            # the type this schema governs
title: Commitment
strict: true                # violations are errors; default: warnings
properties:
  stage:  { kind: enum, values: [planned, confirmed, delivered, cancelled], required: true }
  date:   { kind: date, required: true }
  with:   { kind: link, target: crm-person }   # a relative .md link to a crm-person concept
  tags:   { kind: list, of: enum, values: [talk, family, finance] }
  paid:   boolean                                # shorthand: just the kind
  role:   [speaker, panelist, organizer]         # shorthand: an enum
---

# Commitment

Something the principal has promised to someone: a talk, a duty, a recurring
obligation. The body is the type's documentation; agents read it.
```

Kinds: `string`, `number`, `boolean`, `date` (yyyy-mm-dd), `enum` (with
`values`), `list` (with `of`), `link` (a relative `.md` path that must
resolve in the bundle, optionally to a given `target` type; `brain://`
references are checked by `anima-mesh brains` instead), `slug`.

Rules:

- **Opt-in per type.** Types without a schema stay free-form. Add schemas
  where a wrong value would cost something.
- **Open world.** Properties a schema does not name are allowed;
  frontmatter stays extensible. What a schema names, it enforces.
- **Strictness is the schema's call.** `strict: true` makes violations
  errors, which fail conformance and therefore fail run verification.
  Without it they are warnings, the right setting while a shelf migrates.
- **The schemas are checked too**: unknown kinds, enums without values,
  missing `name`, and two schemas for one type are errors.
- **OKF v0.2 keys keep their meaning** (v2.2.0). `status` is the lifecycle
  (`draft | stable | deprecated`), and `sources` / `generated` / `verified`
  / `stale_after` have fixed shapes ([okf-v0.2.md](okf-v0.2.md)). A schema
  that gives `status` domain values, or redefines the others, gets an
  `ontology/reserved-property` warning. Put a domain lifecycle under
  `stage:` (as above).
- **The ontology lives in the bundle.** Schemas are concepts: versioned in
  git, readable by every agent, editable by the people they describe.

Put schemas wherever reads well; `ontology/<type>.md` is the convention.

## The ontology view

```bash
anima-mesh ontology --instance <brain>
```

prints the type catalog (count, schema status, how many concepts carry a
`share:` marking, an example path), the types still without a schema, every
link type (relative links aggregated as `source type -> target type`), and
the `brain://` references into linked brains. It is derived from the
bundle every time and never stored.

## How this maps to Palantir's Ontology

Palantir Foundry's Ontology is the reference design for an operational
digital twin. The mapping below is what AnimaMesh has today and what it
deliberately does differently. Sources are Palantir's public documentation.

| Palantir | AnimaMesh | Notes |
|---|---|---|
| Object type | concept `type` + optional `concept-type` schema | the file path is the primary key; never regenerate it |
| Property (base types, required) | frontmatter key + schema `properties` | open world: unnamed keys allowed |
| Value type (enum, range, regex) | schema `enum` / `values` | value types as shared, versioned concepts: roadmap |
| Link type | relative markdown links; schema `link` properties with `target` | `anima-mesh ontology` aggregates them by type |
| Interface | (roadmap) | e.g. `party`, `dated-record`, `actionable` across types |
| Action type (parameters, rules, submission criteria, log) | propose/dispose blocks (`schedule-request`, `draft-request`, `defect-report`, `read-request`) gated in code, one ledger line each | typed action concepts: roadmap |
| Action log | `ledger/actions.jsonl` (append-only) | every action is ledgered; an unlogged action fails verification |
| Staging AI edits for human review | the autonomy ladder + approvals | agents propose; deterministic code disposes |
| Decision capture | `decisions/` concepts (dated, immutable) | course changes are new decisions |
| Project (role grants) | a brain (repo) | the brain is the unit of access control |
| Markings (mandatory, conjunctive, travel with data) | `markings:` frontmatter, cleared per link | see [layered-brains.md](layered-brains.md) |
| Role grants | `share:` audiences + `identity.members` roles | deny by default |
| Organizations / shared spaces | org, team, and group brains | collaboration = membership in a shared brain |
| Ontology peering (materialized, one-way source data) | `brains` source (live read) + `brains sync` (materialized law) | "peer, don't link": no cross-repo relative links |
| Branching / proposals | git branches and pull requests | the brain repo is never force-pushed by a machine |

Three deliberate differences:

1. **Plain files, no service.** The twin is markdown in git: readable in any
   editor, runnable by any agent, hostage to no vendor.
2. **Safety in code, not in the model.** Palantir stages AI edits for
   review; AnimaMesh additionally refuses, in code, any action the ladder or
   the constitution does not permit, before review is even possible.
3. **Layers are separate repos.** A person's life and their company never
   share a repo; what crosses is computed from the owner's markings every
   time.

## Roadmap toward a fuller ontology

- **Interfaces**: one schema shape implemented by several types, so agents
  can ask for "every actionable concept" across shelves.
- **Action types as concepts**: parameters, submission criteria (ladder
  level, screens, actor role), and side effects declared in the bundle; the
  generic `action-request` block replaces the four hard-coded ones.
- **Object sets**: saved filters (or saved id lists) as concepts, driving
  views, agent context, and event-driven wakes.
- **Derived properties**: dormancy, counts, last-touch computed from links
  and the ledger instead of stored by hand.
- **Marking propagation**: outputs inherit the markings of what they read.
