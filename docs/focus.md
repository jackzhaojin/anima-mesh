# Focus and the three-line brief

A brain with many agents finds something to say about everything, and a
daily brief that covers everything is a brief nobody reads. Since v2.3.5 a
brain says what matters in one file, and delivery sends the principal only
the top of it.

## The focus file: `bundle/ops/focus.md`

```markdown
---
type: focus
title: "Focus - what matters right now"
date: 2026-10-27
stale_after: 2026-11-26T00:00:00Z
brief: { lines: 3, also: 8 }
---

# Focus

## Top of mind
- The tax return due in March, and the reconciliation that blocks it.

## Secondary
- Choosing a preparer.

## Tertiary
- Research signals, weekly at most.

## Quiet (silent unless the exception fires)
- Business development and the CRM - unless a client writes in first.
- Everything else - unless a filing or tax is due inside 30 days, a legal
  notice arrives, or money moves unexpectedly.

## Hands off (handled elsewhere; never raise or work on)
- Selling the house - another session owns it.
```

- **Every agent reads it first**, every run, beats and chat directions
  alike, ahead of the index and the calendar, with the engine's reading of
  it stated once: top of mind leads, secondary and tertiary get one line,
  a quiet area stays silent unless its exception fires (and the agent says
  which), a hands-off topic is never raised or worked on.
- **It is fine for nothing to matter.** "Quiet: everything, unless a tax or
  legal deadline" is a valid focus for a project on hold.
- **It goes stale.** Past `stale_after` (or 30 days after `date` without
  one) the brief asks once whether it still holds. A brain with no focus
  file gets one line asking the principal to write one.
- `init` scaffolds a template; the [sample brain](sample-brain/bundle/ops/focus.md)
  has a filled-in one.

## Changing it from chat

Give the hub `focus-update` on its whitelist (an L3 reversible action).
Then "@persona make the CRM quiet until January" in a chat direction
rewrites the focus in the same run: the hub returns the complete new body
in a `focus-update` block, the harness keeps the header, sets `date` and a
fresh `stale_after`, writes the file, ledgers `focus-updated`, and the reply
confirms in one sentence. Only the principal moves the dial:

- a scheduled beat never applies a `focus-update`, so the mesh cannot decide
  for itself what matters;
- a direct message (DM, email, slash command) counts as the principal;
- a mention in a shared channel counts only when its sender is listed in
  `animamesh.config.json` → `direction.focusEditors` (channel-native ids,
  such as a Slack user id). Anyone else's request is ledgered as
  `focus-update-denied`.

## The brief: three lines, a short list, a link

The hub's report keeps three sections, and the harness tells the hub so:

1. `## Brief` - at most `brief.lines` lines (default 3): only what needs
   the principal today, or `Nothing needs you today.`
2. `## Also` - at most `brief.also` one-line items (default 8), written
   `- P2 · category: item`, highest priority first.
3. `## Detail` - everything else. Never sent.

Delivery enforces the counts in code. The notification is the Brief lines;
the thread (Slack replies under it; other channels append it) holds the
Also list, `...and N more` when it was cut, and a link to the full report
(its GitHub page on the cloud tier). A report that skipped the format is
still not sent whole: the principal gets its first lines and a note.
`delivery.format: "full"` in the config restores the old whole-report
delivery.

## Nags

Nags (`ops/nags.md`) follow the focus. A top-of-mind nag leads the brief;
others get one Also line; a nag that has not moved in two weeks gets one
weekly "still want this?" line instead of a daily repeat. Move a nag the
principal has set aside under `## Snoozed` with a wake condition; it stays
silent until then. See the sample brain's [nags](sample-brain/bundle/ops/nags.md).
