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

An agent whose whitelist carries `defect-report` can file engine bugs as
GitHub issues on `config.engine.repo` (label `defect`):

- **Scheduled/direction runs**: end output with a fenced block —

  ~~~
  ```defect-report
  title: <one line, engine-generic>
  ---
  <repro, expected vs actual, engine version if known>
  ```
  ~~~

  The harness gates it (ladder level + whitelist), runs the **identity
  leak guard** — the engine repo is public, so a report containing the
  principal's or persona's names or emails is DENIED with the reason
  ledgered, never rewritten — dedupes by title against open `defect`
  issues, files (cap 2/run), and ledgers `defect-reported` /
  `defect-report-denied`.
- **Interactive sessions**: the generated artifacts instruct direct
  `gh issue create --label defect` under the same de-identification rules,
  with a drafts-dir fallback when `gh` is absent.

Credentials, in order: `GITHUB_DEFECTS_TOKEN` (fine-grained PAT, **Issues
R/W on the engine repo only** — the recommended, smallest-blast-radius
credential; a Worker secret on the cloud tier, `.env.local` on the laptop),
else the instance's regular `githubToken` (works only if that identity
carries Issues:write on the engine repo). No credential ⇒ an honest
ledgered denial naming the fix — never a crash.

Grant the whitelist entry deliberately: it belongs on L3 agents whose
judgment you already trust with reversible actions. Shipped templates do
not include it — L1 report-only agents would only generate denials.
