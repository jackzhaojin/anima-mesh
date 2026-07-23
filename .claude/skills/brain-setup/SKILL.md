---
name: brain-setup
description: Interactive setup assistant for standing up a new AnimaMesh company "brain" instance — from an empty directory to a validated, runnable private repo. Use this whenever the user wants to set up a brain, start a company on AnimaMesh, create/scaffold a new instance, onboard a second organization, or asks "how do I get my company running on this engine" — even if they don't use the word "brain" or "instance". Offers a quick setup (three questions, sensible defaults) or a guided questionnaire that recommends which agent archetypes the organization actually needs.
---

# Brain setup — stand up a company on AnimaMesh

You are helping a person create the private **brain repo** for one
organization: knowledge as markdown concepts, an append-only ledger,
file-based approvals, and a config pinning this engine by tag. The engine
already ships the scaffolder (`anima-mesh init`) and nine agent templates;
your job is the judgment layer on top — asking the right questions, picking
the right roster, and leaving the user with a validated instance and clear
next steps. Background reading if you need it:
[docs/starting-a-company.md](../../../docs/starting-a-company.md).

## Step 0 — offer the two paths

Ask one question before anything else:

> **Quick setup** (≈1 minute): three questions, default roster
> (chief-of-staff + compliance-ops), defaults for everything else — you can
> add agents any time later by copying templates.
>
> **Guided questionnaire** (≈5 minutes): a short interview about how the
> organization operates; I recommend a roster from the nine shipped
> archetypes and explain each pick.

Both paths end at the same place: `anima-mesh init` over an empty directory,
then validate, then first run. Neither path ever asks for secrets — setup
needs names and choices, not credentials.

## Step 1 — collect answers

**Quick path.** Ask exactly three things: organization name, principal name
(the human approval gate), and optionally a persona name for the mesh (skip
means the persona is just "Chief of Staff"). Roster:
`chief-of-staff,compliance-ops`.

**Questionnaire path.** Read
[references/agent-archetypes.md](references/agent-archetypes.md) first — it
maps interview answers to archetypes and explains why each one earns its
place. Interview conversationally (don't dump all questions at once), then
present the recommended roster with a one-line "because…" per agent and let
the user veto before scaffolding. Two rules that are not yours to relax:

- **The hub is not optional once there are spokes.** With two or more agents,
  include `chief-of-staff` — without a hub, the principal reads N reports
  instead of one brief, which defeats the design.
- **Commercial agents are dual-gated by the engine.** You may scaffold
  `sales-qualification`, `lead-identification`, or `inbound-triage`, but say
  plainly that they will refuse to run until the instance's activation gates
  open (attorney boundary map verified + trigger/waiver on file). Scaffolding
  them is planning, not activation.

## Step 2 — scaffold

Write the answers to a JSON file and run init with `--answers` (reproducible
and reviewable, unlike one-shot flags). Shape — only `orgName`,
`principalName`, `agents` are required:

```json
{
  "orgName": "Acme Co",
  "principalName": "Ada",
  "personaName": "Quill",
  "description": "One paragraph on what the organization is and does.",
  "timezone": "America/New_York",
  "agents": ["chief-of-staff", "compliance-ops", "bookkeeper"],
  "defaultModel": "kimi-code/kimi-for-coding",
  "defaultHarness": "opencode"
}
```

```bash
pnpm cli init <target-dir> --answers answers.json   # target must be EMPTY
pnpm cli validate <target-dir>                      # must PASS / 0 errors
```

Init refuses non-empty directories by design, and validates its own output —
a failed conformance check is an engine bug, not a user error. Keep the
answers file out of the new repo (it's setup scratch, not knowledge).

Model/harness defaults are fine to leave alone unless the user has a
preference; `anima-mesh templates` lists the available archetypes if you need
to double-check a name. If the user would rather describe the org in prose
and have a model propose the roster, `--agentic [harness]` does that — the
suggestion is advisory and falls back to the human's answers on any parse
failure.

## Step 3 — make it real

Walk the user through, in order (each exists for a reason — say the reason):

1. **Private git repo, immediately.** The brain will hold real corporate
   facts. Never let it live inside a cloud-synced folder (sync conflicts
   corrupt append-only files).
2. **Secrets stay outside git.** `.env.local` (git-ignored, mode 600) holds
   model/channel tokens, referenced by variable name only. Setup itself
   needs none; the first `run` needs a model key.
3. **First run, locally:**
   ```bash
   pnpm cli run <agent> --instance <target-dir>
   pnpm cli report --instance <target-dir>
   ```
   Every agent starts at L1 (report-only) — promotion up the autonomy ladder
   is a frontmatter edit with git history, earned later, never shipped.
   Init also compiled the hub into local interactive surfaces
   (`.claude/agents/` + `.opencode/agents/`) — tell the user they can talk
   to their persona directly with `claude --agent <persona-first-name>` or
   a Tab-switch in opencode, from the brain repo, and regenerate any time
   with `pnpm cli export-local` ([docs/local-agents.md](../../../docs/local-agents.md)).
4. **Seed the bundle.** The scaffold leaves deliberate placeholders: the
   compliance calendar's first hard deadline, the watch-list's first subject,
   and `facts/organization.md` marked `status: unverified` until checked
   against source documents. Point the user at them — an empty calendar
   makes a boring brief.
5. **Cloud tier, when ready.** The same brain runs from Cloudflare Workers
   with the laptop closed — hand them
   [docs/deploying-cloud.md](../../../docs/deploying-cloud.md). Not a
   day-one requirement.

## What NOT to do

- Don't edit `constitution.md` for the user or promise agents can — only the
  principal amends it, by hand, with a dated decision.
- Don't put any real company's name, people, or coordinates into engine
  files, tests, or examples while helping — the engine stays generic;
  identity belongs in the brain you just created
  ([docs/engine-vs-instance.md](../../../docs/engine-vs-instance.md)).
- Don't collect or echo secret values, ever — variable names only.
