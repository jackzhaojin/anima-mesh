# templates/ — the shipped agent roster

Each file becomes a `bundle/agents/*.md` concept in a scaffolded brain. They
are **firm-agnostic by contract**: identity arrives only through placeholders.

## Placeholder contract

| Var | Meaning |
|---|---|
| `{{ORG_NAME}}` | The organization's name |
| `{{PRINCIPAL_NAME}}` | The human approval gate |
| `{{PERSONA_NAME}}` | The mesh's persona (falls back to "Chief of Staff") |
| `{{DEFAULT_MODEL}}` | Model id in the harness's vocabulary |
| `{{DEFAULT_HARNESS}}` | Provider registry name (`claude-code`, `opencode`, …) |

Rendering must leave no `{{` behind — the regression suite checks every
template.

## Back office (active-eligible)

- **chief-of-staff** — the hub: single daily brief, judgment-based routing,
  holds no state. Deploy once a second agent makes coordination real.
- **compliance-ops** — owns the calendar; 60/14/1-day horizons; triages
  official-looking mail by the instance's rules of engagement.
- **bookkeeper** — continuous close; highest-trust spoke; never holds banking
  credentials (works from exports the principal provides).
- **librarian** — re-runnable document-store enrichment; flags contradictions
  between documents and recorded facts (its highest-value output).
- **governance** — quarterly minutes/snapshot/resolutions assembled from
  bundle + ledger.
- **research-watch** — watch-list digests; separates signal (changed decision
  premise) from churn (version bump).

## Commercial (dual-gated — `commercial: true`)

- **sales-qualification**, **lead-identification**, **inbound-triage** —
  designed capable, but `assertActivatable` refuses to run them until the
  instance's boundary map is verified AND a trigger/waiver is on file.

## Frontmatter every agent template must carry

`type: agent`, `name`, `title`, `level: L1` (always — promotion is earned in
the instance, never shipped), `model`, `harness`, `heartbeat`, `whitelist: []`,
`commercial: true|false`.
