---
type: fact
title: "Founder day-job boundary"
status: active
date: 2026-03-10
---

# Founder day-job boundary

Casey holds a full-time role at a large firm while Copperline operates.
Until an attorney-reviewed boundary map exists, every agent job and every
CRM engagement is screened against these constraints:

- **No client delivery.** The mesh researches, drafts, and prepares; it
  never performs billable work for a client.
- **No employer resources.** No employer hardware, accounts, licenses, or
  work product touches this company, ever.
- **No plausibly-covered IP.** Nothing the mesh builds may fall within the
  employment agreement's invention-assignment scope; when in doubt, the
  answer is no until the boundary map says otherwise.
- **Commercial agents stay dual-gated** — see the activation block in
  `animamesh.config.json` and
  [agents/sales-qualification.md](../agents/sales-qualification.md).

The CRM enforces this in data: every engagement carries a `boundary:`
screen field ([crm/taxonomy.md](../crm/taxonomy.md)).
