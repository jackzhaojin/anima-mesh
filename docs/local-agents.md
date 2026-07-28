# Local agent surfaces — talk to your mesh in a coding terminal

The persona IS the concept file. `bundle/agents/<name>.md` is the single
source of truth for who an agent is, on every tier:

| Tier | Wrapper | Context strategy |
|---|---|---|
| Heartbeat run | `buildPrompt` (harness/run-core.ts) | bundle excerpts inlined — L1 needs no tools |
| Direction run | `buildDirectionPrompt` (harness/direction-core.ts) | inlined + the inbound message |
| **Local interactive** | `anima-mesh export-local` → generated artifacts | the agent READS the live bundle itself — it has tools |

`export-local` compiles an agent concept + the instance's identity
(`animamesh.config.json`) into two artifacts under the instance root:

- `.claude/agents/<slug>.md` — **Claude Code**: mention `@agent-<slug>` in
  any session, or run the whole session as the persona with
  `claude --agent <slug>` from the instance repo.
- `.opencode/agents/<slug>.md` — **opencode**: a `primary` agent for the
  hub (Tab-switch in the TUI) and `subagent` for spokes; headless via
  `opencode run --agent <slug> "<message>"`.

Both carry the SAME composed body: the concept's job description verbatim,
plus interactive session rules (read the live bundle first; open with a
stand-up; the bundle is read-only in sessions — work products go under the
drafts dir; gates/ladder/constitution bind unchanged; never echo secrets).
Tuning the personality = editing the concept file and re-running the
export. Never hand-edit the artifacts — the generated-file marker says so.

## Usage

```bash
anima-mesh export-local --instance <dir>              # the hub (default)
anima-mesh export-local --instance <dir> --agents a,b # specific agents
anima-mesh export-local --instance <dir> --all        # every activatable agent
```

- The hub (`delivery.deliverAgent`, default `chief-of-staff`) exports under
  the persona's first name (`identity.persona.name` → e.g. `quill`), because
  the persona rides the hub. Spokes export under their agent names.
- Commercial agents stay dual-gated (D11): naming one explicitly throws
  until the instance's activation gates open; `--all` skips them and says
  why. A local chat surface is still capability.
- `anima-mesh init` runs the export automatically when the roster has a
  hub — new instances start with local surfaces in place.

### Model mapping

The opencode artifact needs `provider/model`. Frontmatter models already in
that form pass through; bare names map (`kimi-for-coding` →
`kimi-code/kimi-for-coding`, `k3` → `kimi-code/k3`, `sonnet` →
`anthropic/claude-sonnet-5`). Override per instance in the config:

```jsonc
"localAgents": {
  "agents": ["chief-of-staff"],        // default export set (optional)
  "opencodeModel": "kimi-code/k3",     // opencode artifact model
  "claudeModel": "sonnet"              // Claude Code artifact model (default: inherit)
}
```

The Claude Code artifact omits `model:` by default — it inherits whatever
the session runs.

## Defect reports — the feedback loop into the engine

An agent whose whitelist carries `defect-report` reports engine bugs —
in the standard posture they **file directly as public engine-repo issues
in the same run**, with a private draft only as the fallback:

- **Scheduled/direction runs**: end output with a fenced block —

  ~~~
  ```defect-report
  title: <one line, engine-generic>
  ---
  <repro, expected vs actual, engine version if known>
  ```
  ~~~

  The harness gates it (ladder level + whitelist), then files it as an
  issue when it can (cap 2/run, ledgered `defect-filed`, title-deduped —
  a recurring bug is one issue, not one per beat) or writes
  `<drafts>/defects/<slug>.md` riding the run's own commit when it can't
  (ledgered `defect-drafted`; same title → same file, refreshed).
- **Interactive sessions**: the generated artifacts instruct the same
  capture, with filing as a separate step.

**The standard posture (v0.11.2, issue-first since v0.11.4) is a
standing instance PAT**: set the `GITHUB_DEFECTS_TOKEN` Worker secret
(Issues R/W on the engine repo; a year-long expiry is the intended shape
— put the renewal on a calendar) and runs file leak-clean reports
directly as issues, keeping **no draft** — the issue tracker is the
record. A draft appears only when filing can't happen: no token, an
identity-leak hit, or an API failure. One token per instance — every
brain that carries it can open issues.

**Tokenless tiers promote drafts deliberately:**

```bash
anima-mesh defect list  [--instance dir]          # what's captured, filed or leaky
anima-mesh defect file <slug> | --all [--instance dir]
```

`defect file` re-runs the **identity leak guard** on the CURRENT file
content — the engine repo is public, so a draft containing the principal's
or persona's names or emails is skipped, never filed, never rewritten
(D2/D13; clean it up by hand first). Clean drafts become issues (label
`defect`, title-deduped against open issues) and the URL is written back
into the draft's `filed:` frontmatter. Credential for this local step: env
`GITHUB_DEFECTS_TOKEN`/`GITHUB_TOKEN`, else the `gh` CLI session.

Grant the whitelist entry deliberately: it belongs on L3 agents whose
judgment you already trust with reversible actions. Shipped templates do
not include it — L1 report-only agents would only generate denials — but
granting it to the hub at its L3 promotion is the STANDARD posture for a
new instance, alongside minting the instance PAT. Interactive artifacts
compiled for a `defect-report` agent carry the same issue-first
instructions (file via the local `gh` session; draft only when filing
can't happen). Every step of the loop that must be trustworthy is
deterministic code, not model judgment: whitelist + ladder gate, the
identity-leak guard, title-dedup, the ledger entry. The model only writes
the report.
