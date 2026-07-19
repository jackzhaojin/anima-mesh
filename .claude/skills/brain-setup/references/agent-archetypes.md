# The questionnaire — mapping an organization to its roster

Nine shipped archetypes (`templates/agents/`). The interview's job is to find
which ones this organization needs **now** — a lean roster that earns each
seat beats a full one that produces noise. Every agent scaffolds at L1
(report-only), so the cost of a wrong pick is a boring report, not a wrong
action; still, each agent adds a daily report the hub must digest, so
default to fewer.

## The interview

Ask conversationally, adapting to what the user has already told you. The
first question is the most important — a good description improves every
agent's prompt forever (it lands in `facts/organization.md`).

| # | Ask about | Listening for | Maps to |
|---|---|---|---|
| 1 | What is the organization, and what stage is it at? | one honest paragraph | `description`, timezone, and context for everything below |
| 2 | Money: are there accounts, transactions, books to keep? | any financial activity at all | **bookkeeper** |
| 3 | Obligations: filings, renewals, licenses, deadlines someone must not miss? | yes for nearly every real entity | **compliance-ops** (near-always) |
| 4 | Documents: is there a document store (cloud drive, docs repo) worth cataloging? | existing corpus of PDFs/contracts/records | **librarian** |
| 5 | Formality: a board, resolutions, minutes, corporate hygiene? | incorporated entities with governance duties | **governance** |
| 6 | Outside world: topics, competitors, or regulations worth a standing watch? | "I keep meaning to track X" | **research-watch** |
| 7 | Commercial motion: actively selling? inbound interest arriving today? | a real pipeline, not an aspiration | **sales-qualification**, **lead-identification**, **inbound-triage** |

Then apply the two structural rules:

- **≥2 agents → add chief-of-staff.** The hub turns N spoke reports into one
  brief and routes by judgment. It holds no state, so it is cheap to include
  and expensive to omit.
- **Commercial picks require the dual-gate disclosure.** The engine's
  `assertActivatable` refuses to run `commercial: true` agents until the
  instance's activation gates open (boundary map verified + trigger/waiver).
  Scaffold them only if the user understands they are planning ahead.

## The archetypes, one line each

**Back office (active-eligible):**

- **chief-of-staff** — the hub: one daily brief, judgment-based routing,
  leads with active nags; the only thing the principal must read.
- **compliance-ops** — owns the calendar; watches 60/14/1-day horizons;
  triages official-looking mail by the instance's rules of engagement.
- **bookkeeper** — continuous close from principal-provided exports; the
  highest-trust spoke; never holds banking credentials.
- **librarian** — re-runnable document-store enrichment; its highest-value
  output is flagging contradictions between documents and recorded facts.
- **governance** — quarterly minutes, snapshots, resolutions assembled from
  bundle + ledger.
- **research-watch** — watch-list digests; separates signal (a changed
  decision premise) from churn (a version bump).

**Commercial (dual-gated, `commercial: true`):**

- **sales-qualification** — qualifies opportunities against the instance's
  boundary map.
- **lead-identification** — surfaces candidate leads from watch-style
  research.
- **inbound-triage** — sorts inbound commercial interest for the principal.

## Worked examples

- *Solo consultant, LLC, no sales pipeline yet, contracts folder in a cloud
  drive* → chief-of-staff, compliance-ops, bookkeeper, librarian. No
  commercial agents — aspiration isn't motion; revisit when pipeline exists.
- *Two-person research lab, grant-funded, tracks three fast-moving fields* →
  chief-of-staff, compliance-ops, research-watch. Bookkeeper when the grant
  brings real transaction volume.
- *Newly incorporated startup, raising, board of three, actively selling a
  pilot* → chief-of-staff, compliance-ops, bookkeeper, governance, plus the
  commercial trio **with** the dual-gate disclosure spelled out.
- *Someone kicking the tires* → quick path: chief-of-staff + compliance-ops.
  The roster is never final — adding an agent later is copying a template
  into `bundle/agents/` and filling the placeholders.
