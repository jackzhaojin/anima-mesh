# Memory layout and indexes

New subject memory defaults to **area/topic/concept.md**: two directory
tiers below the bundle root. An area describes part of the principal's life
or organization; a topic groups related records within it.

```text
bundle/
  index.md
  organization/
    index.md
    identity/
      index.md
      organization.md
    documents/
      index.md
  professional/
    index.md
    talks/
      index.md
      20261112-platform-talk.md
    accolades/
      index.md
      overview.md
```

These areas are examples, not a mandatory taxonomy. A personal brain can
use personal/identity; an organization can use organization/identity.
Small existing areas can stay shallow. Add a third tier only when a
collection needs it; avoid empty categories created just to equalize depth.

## Progressive disclosure

- The root index is an area map plus essential root anchors.
- Area indexes list immediate topic indexes and any direct concepts.
- Topic indexes list immediate records with useful descriptions.
- Link explicitly to `index.md` for consistent filesystem/GitHub resolution.
- Every canonical concept is reachable through indexes from the root.
  Cross-links can provide several views of one canonical home.
- Update local indexes in the same change that adds, moves or retires a
  record; avoid duplicating an exhaustive tree in the root.

Only the root index carries `okf_version: "0.2"` frontmatter. Nested
indexes have no frontmatter; `index.md` and `log.md` are reserved at every
level. These authoring defaults build on [OKF v0.2](okf-v0.2.md). OKF
permits other layouts and makes indexes optional; AnimaMesh requires its
root index and log and continues accepting flat bundles.

## Dates and evergreen records

Use `YYYYMMDD-slug.md` for new dated records. Use the domain date (event,
commitment or decision), rather than the date someone filed the note.
Partial dates stay partial: never invent a day to fit a filename.
Frontmatter dates and log headings retain `YYYY-MM-DD`; timestamps such
as `generated.at` retain an explicit time-zone offset.

Evergreen records use stable names such as `organization.md` or
`overview.md`. Update current understanding in place with sources, actual
verification and freshness; dated events and decisions explain changes.
Existing dated filenames need no mass renaming.

## Knowledge and working material

Related semantic and episodic memory can live together under one subject
area. For example, `bundle/professional/talks/` can contain current talk
summaries and activity subfolders for preparation, research and history.
Activity/phase folders can add depth below the two-tier navigation default.

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
`ops/calendar.md`, `ops/watch-list.md`, `ops/nags.md`, `ops/schedule.md`,
`events/` and the root log. The sample also keeps its constitutional
founder-boundary pointer in place. A refactor does not amend a constitution.

Moving a concept changes its path-based OKF ID. Map old to new paths;
repair links, source/material pointers and agent `reads:` declarations;
review external references. Preserve types, markings, sharing grants,
factual dates and verification history. Historical logs, reports and frozen
drafts retain their prose. Record migrations separately.

The runtime loads nested concepts recursively but inlines only the root
index, operational excerpts and recent events by default. Nested indexes
are navigation, not automatic recursive prompt expansion. Roles declare
required topics/files in `reads:`; directory reads are bounded and omitted
files require explicit retrieval. Review coverage so navigation files do
not crowd out required facts.

Validate bundles and check index reachability, links and required-reading
paths before publishing. The [sample brain](sample-brain/README.md) is a
filled-in example; `anima-mesh init` creates new instances. Engine upgrades
never silently relocate existing brains.
