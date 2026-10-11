# OKF v0.2 in AnimaMesh - how a brain records what it knows

Since **v2.2.0** every AnimaMesh brain is an
[Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)
bundle. This page covers what v0.2 adds, how the engine reads it, and the
exact conventions an AI session or agent follows when it writes a memory
file. Instances point their `CLAUDE.md` / `AGENTS.md` here rather than
restating the rules.

## Why v0.2 matters for a brain

OKF v0.1 said only "markdown + YAML frontmatter + a `type`". That was fine
when a human wrote every file. A brain, though, is **continuously written by
agents**, and a reader (another agent, the principal, a linked brain) needs
four answers that v0.1 left to free text:

| Question | v0.2 field | What AnimaMesh does with it |
|---|---|---|
| Where did this come from? | `sources:` (provenance) | `okf trust` counts unattributed concepts; footnotes cite `sources[].id` |
| Who confirmed it, and how? | `verified:` + the actor convention | trust tier derived in code: unverified · machine-confirmed · human-reviewed |
| Is it the current version? | `status: draft \| stable \| deprecated` | draft and deprecated concepts are named in every agent's context |
| Is it still true? | `stale_after:` | stale concepts are named in every agent's context: re-verify before relying |

Before v2.2.0 the same ideas lived in an overloaded `status:` (verified,
unverified, founder-reported, immutable, active, cataloged, delivered...)
and free-text keys (`source:`, `verified-by:`, `reported-by:`). No code could
read them, so "is this fact safe to put in a filing" was an LLM reading
prose. Now it is a field comparison.

## What the engine does (v2.2.0)

- **Conformance** (`anima-mesh validate`): the `okf` profile is SPEC §11.
  `index.md` / `log.md` are reserved at any level and are not concepts.
  Every v0.2 family is checked as a **warning** (`okf/status`,
  `okf/actor`, `okf/datetime`, `okf/sources`, `okf/footnote-source`,
  `okf/log-*`, `okf/index-frontmatter`, `okf/version`, legacy
  `okf/legacy-timestamp` and `okf/legacy-citations`), because the spec
  forbids rejecting a concept over them. `/bundle-relative` links are
  resolved too. The `animamesh` profile still requires root `index.md` +
  `log.md` (the engine reads both every run).
- **Agent context**: `bundleContext` adds a *Knowledge trust* section listing
  stale, draft, and deprecated concepts plus the tier counts. It appears only
  when the bundle records any of those signals. It is advisory: no gate reads
  a trust tier (SPEC §5.3).
- **`anima-mesh okf trust`**: tier, lifecycle, and provenance roll-up, plus
  the stale, draft, and deprecated lists.
- **`anima-mesh okf migrate [--write]`**: the mechanical v0.1 to v0.2
  rewrite (see *Migrating* below).
- **Writers** emit v0.2. `init` writes `okf_version`, a newest-first log, and
  `generated:` on every concept. `brains sync` writes `generated:` + `sources:`
  on materialized constitutions and logs newest-first.
- **Ontology**: a `concept-type` that gives `status` domain values (or
  redefines `sources` / `verified` / `generated` / `stale_after`) gets
  `ontology/reserved-property`. Domain workflow state goes in its own key,
  conventionally `stage:`.
- **Agent read sources moved**: `sources:` now means provenance in every
  bundle, so an agent's read-source opt-in is **`context-sources:`**
  (`context-sources: [onedrive, brains]`). Legacy string `sources:` on an
  agent still works and warns (`animamesh/agent-context-sources`).

## Writing a memory file - the conventions

These rules are for any AI session or agent that creates or edits a bundle
concept. Humans may follow them too; the validator holds everyone to the
same warnings.

### 1. Frontmatter skeleton

```yaml
---
type: fact                      # REQUIRED. Lower-case house types (fact, decision, event, ...)
title: "Corporate identity"     # recommended
description: One sentence; index entries and search snippets use it.   # recommended
date: 2026-10-11                # AnimaMesh: the concept's domain date (decisions/events require it)
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-11T14:05:00-04:00 }
sources:
  - { id: ein-letter, resource: "Legal/irs-ein/CP575.pdf", title: IRS CP575 notice }
  - { id: founder-report, resource: "founder report, 2026-10-11", author: human:ada }
# verified: only when a check actually happened (see 3)
# status:   only draft or deprecated (see 4)
# stale_after: when the fact has a known shelf life (see 5)
---
```

### 2. Provenance: `sources` and `generated`

- **`generated: { by, at }` on every write.** `by` is YOU as an actor,
  `at` is now. Update `at` (and `by`, if it changed) on every meaningful
  content edit. Typo fixes don't count.
- **Actors** (SPEC §7): `human:<member-id>` for a person (the member ids in
  `animamesh.config.json`, e.g. `human:ada`); `<producer>/<version>` for an
  AI, the harness plus model, e.g. `claude-code/claude-opus-5-5`,
  `anthropic-api/claude-sonnet-5-5`; `process:<id>` for deterministic jobs,
  e.g. `process:anima-mesh-brains-sync`. Never write a free-text name.
- **`sources:` lists what the content was derived from**, one
  `{ id, resource, title?, author? }` entry each. `resource` is a URL, a
  bundle path, a document-store path, `brain://<id>/<path>`, or, when there
  is nothing to follow, a short descriptor (`"founder report, 2026-10-11"`).
  What the principal told you is a source with `author: human:<id>`.
- **Cite claims with footnotes keyed to `sources[].id`**:
  `EIN issued 2025-07-09.[^ein-letter]` plus `[^ein-letter]: IRS CP575 notice`.
  Never cite positionally, and never add a body `# Citations` list (v0.1).

### 3. Trust: `verified` is a record of a check, never a hope

```yaml
verified:
  - { by: claude-code/claude-opus-5-5, at: 2026-10-11T14:05:00-04:00, note: read the signed original }
  - { by: human:ada, at: 2026-10-11T15:00:00-04:00, note: confirmed in session }
```

- Add an entry only when someone actually **checked the content against a
  source or the resource itself**: an AI reading the original document, a
  process reconciling against bank records, the principal confirming it.
  `note:` (optional) says what the check was.
- `human:` entries only when the person themself confirmed. An AI session
  the principal merely supervised is the AI's verification, not theirs. A
  forged `human:` entry inflates a trust tier and is the one migration
  error that can mislead a filing.
- **No `verified` key means unverified**, which is the honest default. A
  fact the principal *told* you is a `sources` entry with
  `author: human:<id>`; it becomes `verified` only once checked against a
  document.
- One verifier can be a bare mapping (`verified: { by, at }`); readers
  treat it as a one-element list.

### 4. Lifecycle: `status` means draft | stable | deprecated, nothing else

- Omit `status` for the normal case: absent means `stable`.
- `status: draft` means not yet reviewed or possibly incomplete.
- `status: deprecated` means kept for links and history, no longer current.
  Use it when a newer concept **fully** replaces this one (e.g. a decision
  wholly superseded). A partial supersession ("only its model choice")
  leaves the old one `stable` and is described in the new one's
  `supersedes:` prose.
- Domain workflow state is **not** `status`: a talk's lifecycle is
  `stage: confirmed`, a document's librarian state is
  `extraction: cataloged | extracted`, a CRM record has `stage:`.

### 5. Freshness: `stale_after`

An absolute instant after which the content should be re-verified before
anyone relies on it: an annual filing status, a price sheet, a balance, a
policy with a renewal date. `stale_after: 2027-03-01T00:00:00-05:00`. Every
agent run lists stale concepts until someone re-verifies and moves the date.

### 6. Datetimes

Every OKF timestamp (`generated.at`, `verified[].at`, `stale_after`,
`sources[].last_modified`) is ISO 8601 **with an offset**:
`2026-10-11T14:05:00-04:00` or `...Z`. AnimaMesh's own `date:` stays a plain
`YYYY-MM-DD` domain date. History migrated from date-only records uses
local midnight (`2026-07-06T00:00:00-04:00`).

### 7. Reserved files

- **`index.md`**: no frontmatter, except the bundle root, which carries
  only `okf_version: "0.2"`. The body is sections of
  `* [Title](path) - description` entries.
- **`log.md`**: no frontmatter, then `# Bundle log`, then `## YYYY-MM-DD`
  date groups **newest first**. Add today's entry at the TOP of today's
  group (create the group above the previous newest). Entries are prose,
  conventionally `- **Update**: ...` / `- **Creation**: ...` /
  `- **Deprecation**: ...`, or a `### Title` subsection for a longer
  story. Never rewrite an old entry; corrections are new entries.

### 8. What did not change

One concept per file, `type` required, decisions dated and never edited
after the fact (course changes are new decisions), events append-only,
the constitution never touched by an agent, `markings:` / `share:` on
anything that leaves the brain. v0.2 adds signals, not new freedoms.

## Migrating a v0.1-era brain

1. `anima-mesh okf migrate --instance <brain>` (dry run), then `--write`.
   It rewrites only what has one right answer: index/log frontmatter,
   newest-first log regrouping (entries keep their words), agent
   `sources:` to `context-sources:`, and `status: active` / `status:
   unverified`, which already equal the v0.2 defaults.
2. Work the **needs judgment** list it prints. The usual mappings:

   | v0.1-era AnimaMesh | v0.2 |
   |---|---|
   | `status: verified` + `verified-by: "session read of original, <date>"` | `verified: { by: <harness>/<model that did it>, at: <date>, note: ... }` (git co-author lines say which model) |
   | `status: verified` after a principal-witnessed check | `verified: { by: human:<id>, at, note }` |
   | `status: founder-reported` / `reported-by:` | drop; `sources: [{ id: founder-report, resource: "founder report, <date>", author: human:<id> }]` |
   | `source: "<path>"` (singular) | `sources: [{ id: original, resource: "<path>", title }]` |
   | bare-string `sources:` entries | `{ id, resource, title? }` entries |
   | `status: immutable` / `decided` / `made` on decisions | drop (immutability is a house rule, not a lifecycle) |
   | `status: cataloged` / `extracted` on documents | `extraction: cataloged` / `extracted` |
   | domain `status:` in a `concept-type` | rename the property (`stage:`) in the schema and its concepts |
   | `timestamp:` | `generated: { by, at }` when the writer is known; otherwise leave it (readers fall back) |

   Never guess a `verified` entry. Leaving one out understates trust;
   inventing one forges it.
3. Root index: replace "OKF v0.1" wording; log intro: "newest first".
4. `anima-mesh validate` until 0 warnings, then pin the engine.

## Not adopted (yet)

**Attested Computations** (SPEC §10) are recognized by the validator
(`runtime`, `# Computation`) but the engine does not execute or attest
them: no AnimaMesh agent computes a sanctioned figure today. When a brain
needs one (a revenue number for a filing, say), the executor and attester
fit behind the existing gate and verifier seams. That is a feature line to
plan, not a side effect of this one.
