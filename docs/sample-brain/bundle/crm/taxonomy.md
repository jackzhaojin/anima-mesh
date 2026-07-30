---
type: crm-taxonomy
title: "CRM taxonomy and binding rules"
status: active
date: 2026-06-01
---

# CRM taxonomy

The bundle is the CRM — records are concepts, git history is the audit
trail. Types: `crm-org` (`orgs/`), `crm-person` (`people/`),
`crm-engagement` (`engagements/`); interactions are appended to the
engagement they belong to.

## Stages

`identified → researched → drafted → sent → in-conversation → won/lost/parked`

## Rules (binding on every agent)

1. **The founder sends everything.** No outreach leaves under the firm's
   or the persona's name; `drafted` is the mesh's last stage.
2. **The hub proposes, never writes.** Mira surfaces stale warm contacts
   (last-touch > 90 days), empty `next-action` fields, and boundary
   violations in her brief; edits happen in founder sessions.
3. **The boundary lives in the data.** Every engagement carries
   `boundary:` — the screen against
   [../facts/founder-boundary.md](../facts/founder-boundary.md); an
   engagement that fails the screen is recorded and parked, not hidden.
4. **Warmth is earned, dated, and decays.** `warmth:` is set from real
   interactions with dates, never asserted.
