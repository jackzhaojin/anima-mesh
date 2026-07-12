# Starting a company on AnimaMesh

*From an empty directory to a mesh that runs a real company's back office.
The engine is company-agnostic by construction — this is the same path
whether it's your first instance or your fifth. Any capable AI model can
operate this playbook; nothing below assumes a particular assistant.*

## 0. What you're building

One private **brain repo** per company: knowledge as markdown concepts, an
append-only ledger, file-based approvals, and a config that pins this engine
by tag. The engine animates it; you review and approve. Humans do judgment
and signatures; agents do everything preparable.

## 1. Scaffold the brain

```bash
pnpm cli init ../acme-brain --org "Acme Co" --principal "Ada" \
  --agents compliance-ops,chief-of-staff
pnpm cli validate ../acme-brain        # must PASS before anything runs
```

The init interviews you (or takes flags / an answers file), fills the agent
templates, and emits a conformant bundle: `constitution.md` (the immutable
hard limits), `facts/`, `decisions/`, `events/`, `ops/calendar.md`,
`agents/*.md`. Make it a **private** git repo immediately — the brain will
hold real corporate facts. Never let it live inside a cloud-synced folder.

House rules that keep the bundle trustworthy as it grows:

- One concept per file; corrections to events are new events; superseded
  decisions are new dated decisions. `log.md` is append-only.
- Facts carry `status:` — an unverified fact is a lead, not something to
  file with the government. Verify against source documents before relying
  on it, and never state a corporate fact from model recall: read the
  concept.
- The constitution is edited by the principal, by hand, with a decision
  entry — never by an AI session.

## 2. First runs, locally

```bash
pnpm cli run compliance-ops --instance ../acme-brain
pnpm cli report --instance ../acme-brain
pnpm cli gate list --instance ../acme-brain
```

Every agent starts at **L1 (report-only)**: the harness writes the report,
appends the ledger, and runs the verifiers — the agent itself causes no side
effects. Promotion up the autonomy ladder (L2 draft-for-approval, L3
whitelisted reversible actions, L4 gated external actions) is a frontmatter
edit with git history: trust as an operational dial with a paper trail.

## 3. Choose cognition

Each agent's concept declares `model` + `harness`. Mix freely: an expensive
model for the chief of staff, a cheap one for a watcher. Two rules learned
the hard way:

- If an agent should ever run in the cloud, its **effective** harness must
  be pure-fetch (`CLOUD_HARNESSES`) — and probe the vendor endpoint from a
  real Worker before committing to it ([learnings](learnings/README.md)).
- Route around vendor trouble with `animamesh.config.json →
  cognition.overrides` (declared harness → actually-executed harness) —
  a config edit, not an agent rewrite, and reversible by deleting the block.

## 4. Connect the principal

- **Delivery** (`delivery` in config): where the daily brief lands —
  Discord bot DM, Notion page, Gmail, or console while you're bootstrapping.
- **Directions**: give the persona a Discord app and the principal can
  message the mesh directly; a polled Gmail inbox does the same for email.
  Inbound is sender-gated, budget-capped, and read *agentically* — the
  agent decides the disposition, no keyword commands to memorize.
- **Nags**: `ops/nags.md` entries repeat in every brief, with age, until
  done — the mesh politely refuses to let you forget your own blockers.

## 5. Go to the cloud

Follow [deploying-cloud.md](deploying-cloud.md). From then on the mesh runs
with the laptop closed: daily beat, one evidence commit, brief in your DMs.
Keep the CLI around — it's the same engine over the same repo, useful for
manual runs and as home for subprocess-only harnesses.

## 6. Operate

The daily rhythm is: **read the brief → approve or deny gates → answer or
issue directions → sign what needs signing.** Observability is git first
(`git log --author=<mesh-identity>`), the dashboard for at-a-glance state,
`/healthz` for liveness. When something breaks, the mesh DMs you — silence
must mean success, so verify the silence occasionally (check `/healthz`
after the beat hour).

## 7. Evolve

- Capabilities built inside the brain for expedience get flagged
  **"generalize me"** and later promoted into the engine, de-identified —
  the checklist is in [engine-vs-instance.md](engine-vs-instance.md).
- Engine upgrades are deliberate: the brain pins a tag; upgrading = bump
  `engine.ref`, redeploy, note it in the log. Patch tags carry fixes worth
  reading ([learnings/](learnings/README.md)).
- The second company starts at step 1 with the same engine — nothing from
  the first company carries over except everything you taught the engine.
