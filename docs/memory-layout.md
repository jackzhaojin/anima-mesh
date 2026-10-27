# Memory layout and indexes

A brain's memory is **two tiers deep by default and three at most**.
Below the bundle root sits an area; inside an area the first tier is a
**calendar year** when the memory is time-sensitive, or a **topic** when it
is not; a second tier is optional and can be whatever groups the files
best. Nothing goes deeper.

```text
bundle/
  index.md                     root map of areas
  log.md                       newest-first change history
  constitution.md
  events/                      time-sensitive area
    index.md                   lists the years
    2026/                      tier 1: the calendar year
      index.md
      20261027-first-customer.md
  decisions/
    2026/
      20261014-pricing-model.md
  professional/                time-sensitive area
    index.md                   lists years, plus talks/accolades views
    talks-guide.md             evergreen notes can sit at the area root
    2026/
      20261111-platform-talk.md        summary record
      20261111-platform-talk/          tier 2: one item's workspace
        index.md
        20261020-brainstorm-notes.md
        slides-outline.md
  finance/                     topical area
    index.md
    banking/                   tier 1: a topic
      checking.md
    retirement/
      overview.md
  ops/                         runtime anchors stay flat
    calendar.md
```

The areas are examples, not a mandatory taxonomy. Pick per area:

- **Time-sensitive** (most records carry a domain date: events, decisions,
  commitments, talks, dated documents) - the first tier is always the
  calendar year of the record's date, `YYYY`. Evergreen guides and
  overviews for the area may sit at the area root beside the years.
- **Topical** (records are evergreen: identity, accounts, banking, people)
  - the first tier is a topic. A small topical area (a handful of records)
  may hold its records directly until a split earns its place; don't create
  one-file folders to equalize depth.
- **The second tier** is free: one talk's or one deal's workspace, a month
  (`2026/10/`) when a year gets crowded, or a sub-topic. Inside a topic,
  dated records may sit directly or get year folders once the topic is busy.
- **Never a fourth folder.** When a workspace has phases (submission,
  prep, logistics), flatten them into the workspace with date-prefixed
  names (`20260830-talk-prep-draft-v2.md`) rather than nesting.

`anima-mesh validate` warns (never errors) on concepts more than three
folders deep (`animamesh/layout-depth`) and on decision or event concepts
outside a year folder (`animamesh/layout-year`). Flat bundles stay valid.

## Progressive disclosure

- The root index is an area map plus essential root anchors.
- Area indexes list their years or topics and any direct records.
- Year and topic indexes list immediate records with useful descriptions.
- Link explicitly to `index.md` for consistent filesystem/GitHub resolution.
- Every canonical concept is reachable through indexes from the root.
  An area index may also give a topical view of a time-sensitive area
  (talks, accolades) by linking into the year folders.
- Update local indexes in the same change that adds, moves or retires a
  record; avoid duplicating an exhaustive tree in the root.

Only the root index carries `okf_version: "0.2"` frontmatter. Nested
indexes have no frontmatter; `index.md` and `log.md` are reserved at every
level. These authoring defaults build on [OKF v0.2](okf-v0.2.md). OKF
permits other layouts and makes indexes optional; AnimaMesh requires its
root index and log and continues accepting flat bundles.

## Dates and evergreen records

Use `YYYYMMDD-slug.md` for dated records, with the domain date (event,
commitment or decision), not the date someone filed the note. The year
folder is that date's year. Partial dates stay partial: never invent a day
to fit a filename. Frontmatter dates and log headings keep `YYYY-MM-DD`;
timestamps such as `generated.at` keep an explicit time-zone offset.

Evergreen records use stable names such as `organization.md` or
`overview.md`. Update current understanding in place with sources, actual
verification and freshness; dated events and decisions explain changes.

## Knowledge and working material

Related semantic and episodic memory can live together under one area.
A talk's summary record sits in its year folder; the preparation,
research and history for it sit in a same-named workspace folder beside it.

Every Markdown document inside the bundle must remain a typed OKF concept,
including supporting README files, instructions and historical notes.
Use `type: reference` for supporting material and an optional producer field
such as `memory-layer: working` or `memory-layer: episodic`. Preserve any
existing factual type, sources, verification, dates, markings and sharing.
Adding a metadata envelope must not rewrite frozen drafts or dictated prose.
No new verification is implied by packaging old text as a concept.

Keep current summaries authoritative and index the supporting history
separately. Declare specific summary files under agent `reads:` when a
workspace is large; recursively inlining every draft consumes bounded
context and can hide current commitments. Small linked assets may sit
alongside notes. Original documents and large media stay in the principal's
document store; disposable build outputs and operational drafts may remain
outside the bundle.

## Runtime and migration boundaries

Established control paths stay stable: `constitution.md`, `agents/`,
`ops/focus.md`, `ops/calendar.md`, `ops/watch-list.md`, `ops/nags.md`, `ops/schedule.md`,
the root index and log, and any concept the constitution links to: a
refactor never edits the constitution, so those concepts stay where they are
(the layout warnings skip them) until the principal moves the link by hand.
`events/` stays the event stream:
the harness reads it recursively, so year folders work, and inlines the
newest few by the date in their filenames.

Moving a concept changes its path-based OKF ID. Map old to new paths;
repair links, source/material pointers and agent `reads:` declarations;
review external references. Preserve types, markings, sharing grants,
factual dates and verification history. Historical logs, reports, the
ledger and frozen drafts keep their prose; only their links are repaired.
Record the migration in the log.

The runtime loads nested concepts recursively but inlines only the root
index, operational excerpts and recent events by default. Nested indexes
are navigation, not automatic recursive prompt expansion. Roles declare
required topics/files in `reads:`; directory reads are bounded and omitted
files require explicit retrieval. A role that should see a year's catalog
declares that year's index (`decisions/2026/index.md`) and rolls it over
in January.

Validate bundles and check index reachability, links and required-reading
paths before publishing. The [sample brain](sample-brain/README.md) is a
filled-in example; `anima-mesh init` creates new instances. Engine upgrades
never silently relocate existing brains.
