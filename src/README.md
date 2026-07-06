# src/ — architecture map

Read [../CLAUDE.md](../CLAUDE.md) for working agreements. This is the
module-by-module tour, in dependency order (each layer only imports from the
ones above it).

## okf/ — the knowledge layer

- `frontmatter.ts` — parse/serialize one concept file (YAML frontmatter +
  markdown body). Returns `null` for no-frontmatter files, **throws** on
  malformed YAML — silent repair would mask corruption in an organization's
  knowledge.
- `bundle.ts` — walk a bundle dir into `{root, concepts[]}`. Tolerant loader:
  parse problems are *recorded* on the concept (`missingFrontmatter`,
  `parseError`) so conformance can report them all at once.
- `conformance.ts` — the validator. Profile `okf` = reserved `index.md` +
  `log.md`, every concept parses and has a `type`. Profile `animamesh` adds:
  constitution present and `immutable: true`, decisions/events dated, agent
  concepts declare `model`/`harness`/`level`. Broken relative links are
  warnings, not errors.

## ledger/ — the audit seam

`Ledger` appends JSONL, never truncates. `integrity()` (every line parses) and
`assertRunLogged()` (every declared action appeared) are the deterministic
assertions verifiers build on.

## gates/ + autonomy/ — the safety layer

- `autonomy/ladder.ts` — L1 report → L2 +draft → L3 +whitelisted reversible →
  L4 +external. `requiresGate("external")` is `true` unconditionally: L4 never
  exempts an action from its gate.
- `gates/approvals.ts` — file-based approval records (`<id>.json`), one per
  consequential action. Decisions are terminal (no un-approving).
- `gates/gatekeeper.ts` — `assertActionAllowed` throws `GateViolation` unless
  (1) the ladder allows the category, (2) reversible actions are whitelisted,
  (3) gated types carry a *matching approved* record. Gated-type vocabulary
  loads from the constitution concept as a **union with the built-in floor** —
  a constitution can add gates, never remove them.

## agents/ + instance/ — configuration as knowledge

- `agents/concept.ts` — an agent IS its concept file: `level`, `model`,
  `harness`, `whitelist`, `commercial` in frontmatter; the job description is
  the body. `assertActivatable` enforces the commercial dual gate
  (boundary map verified AND trigger/waiver) from `animamesh.config.json`.
- `instance/config.ts` — resolve an instance root (config + bundle + ledger +
  approvals + reports + drafts paths).

## providers/ — the chokepoint

`AgentWorkerProvider` = `{name, assertConfigured(), run(opts)}`. Everything
model-related crosses this seam and nothing else does.

- `claude-code.ts` — spawns `claude -p … --output-format text`.
- `opencode.ts` — long-lived `opencode serve` **per working directory** (the
  session's relative reads must resolve against the instance), REST session +
  message, SSE `/event` tap for live tool-firing progress. Default model:
  Kimi K2.6 (`kimi-code/kimi-for-coding`).
- `fake.ts` — deterministic, records calls; the regression suite's provider.
- `index.ts` — registry; instances can `registerProvider()` their own.

## harness/ — one heartbeat

- `run.ts` — `runAgent`: load instance → find agent → activation + ladder
  checks → assemble prompt (job + inlined `index.md`/`ops/*` + latest mesh
  reports + pending approvals) → provider.run with **cwd = bundle root** →
  harness writes the report artifact (L1 contract: the agent causes no side
  effects) → ledger appends → verifiers.
- `verifiers.ts` — the three seam checks (+ conformance): expected outputs
  exist, no gated ledger entry without its approval, all declared actions
  logged, bundle still conformant.

## init/ — a brain from nothing

- `templates.ts` — locate/fill `templates/agents/*` (`{{VAR}}` substitution,
  deliberately dumb).
- `scaffold.ts` — `scaffoldBrain(emptyDir, answers)` writes config, bundle
  (index/log/constitution/facts/ops/events/agents), and operational dirs —
  then **runs conformance on its own output and throws if it fails**.
- `interview.ts` — answers from file, flags, interactive prompts, or
  `agenticEnrich` (a provider refines the answers; malformed model output
  falls back silently — model proposes, code disposes).

## cli.ts

`main(argv) → exit code`, so tests drive it in-process. Commands:
`init · validate · run · gate · report · templates`.
