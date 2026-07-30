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

Beyond the bundle, `init` also compiles the hub's **local interactive
surfaces** (`.claude/agents/` + `.opencode/agents/` — see
[docs/local-agents.md](../docs/local-agents.md)) from the scaffolded
concept, so a new instance can talk to its persona in a coding terminal on
day one. Templates deliberately ship WITHOUT the `defect-report` whitelist
entry — at the shipped L1 it would only generate denials. But granting it
IS the standard path, not an exotic option: when the principal promotes
the hub to L3, add `defect-report` to its whitelist, and set the
instance's standing PAT (`GITHUB_DEFECTS_TOKEN`, see
`workers/heartbeat/wrangler.example.jsonc`) so the mesh reports engine
bugs as public issues on its own. The whole loop is deterministic
capability, not model discretion: code gates the whitelist + ladder
level, runs the identity-leak guard, title-dedups against open issues,
files, and ledgers — the model only writes the report.

## Back office (active-eligible)

- **chief-of-staff** — the hub: single daily brief, judgment-based routing,
  holds no state. Deploy once a second agent makes coordination real. Once
  promoted with `schedule-update` whitelisted, it can wake other agents for
  the next beat via a `schedule-request` block (gated in code, ledgered).
  Two conditional duties ship in the job: CRM stewardship when the bundle
  has a `crm/` shelf (surface stale relationships and empty next-actions —
  propose, never write), and prep packs per open obligation once trusted
  with `draft-write` (an L3 promotion; packs live under the drafts dir
  only).
- **compliance-ops** — owns the calendar; 60/14/1-day horizons; triages
  official-looking mail by the instance's rules of engagement. Ships
  `web: 4` — enough to confirm the calendar's standing external status
  checks, not open-ended browsing.
- **bookkeeper** — continuous close; highest-trust spoke; never holds banking
  credentials (works from exports the principal provides).
- **librarian** — re-runnable document-store enrichment; flags contradictions
  between documents and recorded facts (its highest-value output).
- **governance** — quarterly minutes/snapshot/resolutions assembled from
  bundle + ledger.
- **research-watch** — watch-list digests; separates signal (changed decision
  premise) from churn (version bump). Ships `web: 8`, the roster's largest
  budget — external digesting is the one job the bundle alone cannot do, and
  this agent was the direct subject of engine issue #4: told to do web
  checks on a harness with no web capability, it reported a tool failure
  that was never a tool. Its job now says plainly what to do when the run
  refuses the budget.

## Commercial (dual-gated — `commercial: true`)

- **sales-qualification**, **lead-identification**, **inbound-triage** —
  designed capable, but `assertActivatable` refuses to run them until the
  instance's boundary map is verified AND a trigger/waiver is on file.

## Frontmatter every agent template must carry

`type: agent`, `name`, `title`, `level: L1` (always — promotion is earned in
the instance, never shipped), `model`, `harness`, `heartbeat`, `whitelist: []`,
`commercial: true|false`. Optional: `web: <n>` — web searches the agent may
spend per run, honored only on harnesses that declare the `webSearch`
capability; the prompt states the grant — or the refusal — out loud, so an
unrun check is reported as a gap, never as "nothing changed".
