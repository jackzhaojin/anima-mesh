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

When the user wants to see what a *finished* brain looks like — or you need
a reference shape for any concept (a nag file, a prep pack, a CRM record, a
promoted hub) — read [docs/sample-brain/](../../../docs/sample-brain/README.md):
a complete scrubbed production instance that validates and runs
credential-free. Copy shapes from it freely; never copy its fictional facts.

## Step 0 - check that this needs a new brain

A brain is one per **boundary**, not per project: one for a person, one for
each organization whose knowledge belongs to it, one for each group of
people who share work. If the user already has a brain and wants one for a
new project, product, client, talk, or side effort, say so plainly and
offer the alternative instead: a folder in the existing brain, with big
files in its file cabinet (the drive it links to). Go on only when the new
brain has a different owner or a different set of people
([docs/layered-brains.md](../../../docs/layered-brains.md#when-to-start-a-new-brain-rarely)).

## Step 0b - offer the two paths

Then ask one question before collecting anything:

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

If the brain will hold someone else's proprietary knowledge (an employer's
or a client's), add `--local` (or `"localOnly": true` in the answers file):
the engine then keeps it on the machine, with no cloud tier, chat or mail
delivery, cloud read sources, web search or public issues
([docs/local-only.md](../../../docs/local-only.md)). Ask before assuming
either way, and skip the cloud-tier step for a local brain.

Ask where the brain will live. Git is the default (and the cloud tier needs
it). A team without git can keep it in OneDrive, SharePoint, Google Drive or
Dropbox: add `--storage synced --provider <drive>`, have every machine keep
the folder downloaded and set `ANIMAMESH_WRITER`, keep the engine checkout
outside the drive, and run `pnpm cli doctor --instance <dir>`
([docs/storage.md](../../../docs/storage.md)).

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

1. **Private git repo, immediately** (or the synced drive chosen above).
   The brain will hold real corporate facts. A git brain never lives inside
   a cloud-synced folder; a synced brain is set up with `--storage synced`
   so each machine writes its own ledger shard.
2. **Pick its document store.** Recommend one for almost every brain: the
   brain is memory and index, the store holds the documents of record
   (contracts, tax forms, statements, decks). Ask which the organization
   already uses - personal Google Drive or OneDrive for a person brain;
   Google Workspace (My Drive or shared drives); SharePoint, OneDrive, or
   Teams files on Microsoft 365 - and wire the matching read-only source
   (`google-drive`, `onedrive`) on the agents that need it. Concepts then
   summarize what matters and link the store path; documents never get
   copied into the bundle
   ([starting-a-company.md](../../../docs/starting-a-company.md), "Pair the
   brain with a document store").
3. **Secrets stay outside git.** `.env.local` (git-ignored, mode 600) holds
   model/channel tokens, referenced by variable name only. Setup itself
   needs none; a real-model `run` needs a model key — but a credential-free
   dry run works today: scaffold with `"defaultHarness": "fake"` (or
   `--harness fake`) and the deterministic provider completes the full
   loop — report, ledger, verifiers — offline. Switch an agent to real
   cognition later by editing its `model:`/`harness:` frontmatter.
4. **First run, locally:**
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
5. **Seed the bundle.** The scaffold leaves deliberate placeholders: the
   compliance calendar's first hard deadline, the watch-list's first subject,
   and `organization/identity/organization.md` (or
   `personal/identity/person.md`), unverified (no `verified:` key) until
   checked against source documents. Point the user at them — an empty
   calendar makes a boring brief. Every memory file after that follows
   the OKF v0.2 writing conventions in
   [docs/okf-v0.2.md](../../../docs/okf-v0.2.md): copy that pointer into
   the new brain's `CLAUDE.md` / `AGENTS.md`. Also copy the
   [two-tier memory and indexing convention](../../../docs/memory-layout.md):
   an area, then a calendar year for time-sensitive memory or a topic for
   evergreen memory, then at most one more level (never a fourth folder);
   the root maps areas, local indexes list immediate children with
   descriptions, evergreen names stay stable and dated filenames use
   YYYYMMDD. Keep runtime anchor paths
   and mandatory role reads working. Related summaries and episodic working
   notes may share an area under the bundle; supporting Markdown must have
   OKF metadata and frozen/dictated bodies stay intact. Large originals stay
   in the document store. Do not reorganize other brains during setup.
6. **Cloud tier, when ready.** The same brain runs from Cloudflare Workers
   with the laptop closed — hand them
   [docs/deploying-cloud.md](../../../docs/deploying-cloud.md). Not a
   day-one requirement.
7. **Core engine feedback.** Every scaffold includes
   `bundle/ops/engine-feedback.md`, required reading for the personal and
   organizational hubs. Explain it as a standard setup capability: the
   principal records a narrow public-engine-issue grant, promotes the hub
   to L3 with only `defect-report` if that is all they need, and provisions
   `GITHUB_DEFECTS_TOKEN` for the configured `engine.repo`. New hubs remain
   L1 until that authorization. Include the dedicated key in each filing
   runtime's local environment, Worker secret uploader, local Worker env
   generator, and CI wiring where present; a brain-store token or GitHub
   App does not substitute for it. Never ask for or print the token value.
   Regenerate local artifacts after a promotion. Verify through the run
   report and `defect-filed` ledger entry with an issue URL, or report the
   missing setup / private fallback honestly. Engine bugs and requested
   enhancements use general requirements and synthetic examples only.

## What NOT to do

- Don't edit `constitution.md` for the user or promise agents can — only the
  principal amends it, by hand, with a dated decision.
- Don't put any real company's name, people, or coordinates into engine
  files, tests, or examples while helping — the engine stays generic;
  identity belongs in the brain you just created
  ([docs/engine-vs-instance.md](../../../docs/engine-vs-instance.md)).
- Don't collect or echo secret values, ever — variable names only.
