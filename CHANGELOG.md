# Changelog

AnimaMesh is pre-1.0, so this history is organized by **minor release line**:
the capability boundary operators actually adopt. Patch tags are deliberately
rolled into the value and maturity of their minor rather than narrated one by
one. The latest tag is **v0.8.0**.

## Upgrade procedure

Upgrade one private instance at a time:

1. Read every minor section from the currently pinned line through the target
   line. Upgrade notes are cumulative.
2. Fetch the latest patch tag in the target line, install its locked
   dependencies, and run `pnpm verify` in the engine checkout.
3. In the private brain, update `animamesh.config.json → engine.ref`, run
   `pnpm cli validate <brain>`, and record the upgrade in the instance log.
4. From v0.3 onward, compare the instance's private `cloud/wrangler.jsonc`
   files with the target tag's `workers/*/wrangler.example.jsonc`. Merge new
   bindings, Durable Object migrations, variables, and secret names without
   replacing instance-specific values.
5. Redeploy each affected Worker. Check `GET /healthz`, trigger one
   authenticated `POST /beat`, and confirm the mesh-authored commit and brief
   delivery before considering the upgrade complete.

No release through v0.7 requires an existing bundle or ledger to be rewritten.
The ledger remains append-only; never "migrate" it by editing old entries.

## [Unreleased]

- Docs: the **CRM domain shelf** (`docs/okf-crm-domain.md`) — the first
  front-office OKF domain: `crm-org` / `crm-person` / `crm-engagement` /
  append-only `crm-interaction` concepts, relationship-first stages,
  views-are-grep, and compliance screens encoded in record frontmatter.
  Promoted from a live instance, de-identified. No engine code was
  required: conformance is type-agnostic by design, and the R4 link rule
  already machine-checks the relationship graph.
- Docs: README rewritten to foreground the OKF vocabulary (concepts,
  types, conformance profiles, the machine-checked knowledge graph) and
  the domain-shelf extension model; `starting-a-company.md` gained the
  re-aiming (direction pivot) playbook.

## [v0.8.x] — durable GitHub auth and honest failure signals

**Latest tag: v0.8.0 · 2026-07-18**

### Value

v0.8 removes the two quietest ways the cloud tier could die or lie.

**GitHub App installation tokens** replace the PAT as the brain-repo auth
(`github-auth.ts` — the long-designed one-file swap). The engine signs a
short-lived RS256 JWT with WebCrypto, exchanges it for a ~1-hour
installation token, and caches it until near expiry. No credential with
repo write ever crosses the network long-lived, and there is no expiry
cliff: App keys rotate on the operator's schedule, zero-downtime. The PAT
path remains supported when no App var is set; a **partial** App config
fails loudly instead of falling back (a silent fallback would mask App
breakage until the PAT died). PKCS#1 keys — the format GitHub actually
downloads — are detected and rejected with the exact `openssl pkcs8`
conversion command in the error.

**Silence means success, now for spoke failures too.** Previously a beat
where *every* due agent failed delivered no brief and no DM —
indistinguishable from a quiet "nothing due" morning. Any beat with
failures now sends the principal a failure DM naming the agents, whether or
not a brief exists.

Also in the line:

- **Spend visibility**: provider usage normalizes into each run report and
  the `run-completed` ledger entry, and beats sum it into the summary —
  `/healthz` now shows tokens per beat for a mesh running on subscription
  quota.
- Bearer-gated Worker routes compare tokens in constant time
  (`crypto.subtle.timingSafeEqual`) instead of `!==`.
- `docs/deploying-cloud.md` gains the generic CI deploy shape (pipeline in
  the instance repo, engine `pnpm verify` before any deploy, a
  Workers-Scripts-only API token, sibling engine checkout).
- Cloud execution documented as the primary operating mode (docs-only
  changes previously in Unreleased).

### Upgrade from v0.7

- Pin to v0.8.0 and redeploy both Workers. No bundle, ledger, Durable
  Object, or dashboard migration; the ledger's new optional
  `detail.tokens` field on `run-completed` entries is additive.
- To adopt App auth: create a GitHub App (Contents read/write, installed on
  the brain repo only), convert its key to PKCS#8, and set
  `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY`
  on both Workers (pipe the PEM: `wrangler secret put GITHUB_APP_PRIVATE_KEY
  < app.pem`). Prove a beat, then delete the `GITHUB_TOKEN` secret so a
  broken App path can never hide behind the fallback.
- Staying on a PAT requires no change.

## [v0.7.x] — external document context that works in production

**Latest tag: v0.7.3 · 2026-07-18**

### Value

v0.7 makes a git-hosted document corpus first-class agent context. The new
`github-docs` source gives the same corpus two read-only access paths: GitHub
REST for the primary cloud runtime and a local working tree for the CLI. Agents
see a bounded, current listing without receiving write access, and failures
become honest prompt sections instead of aborted runs or guessed context.

The line also turns the source and cognition paths into production-grade cloud
behavior:

- `GET /docs/check` validates the configured corpus behind the same bearer gate
  as manual beats.
- Cloud GitHub requests carry the headers GitHub requires and surface bounded
  API error bodies, making permission and rate-limit failures diagnosable.
- The Node path can include uncommitted local documents while keeping filesystem
  code outside the Worker import graph.
- `anthropic-api` budgets for adaptive thinking and retries once with thinking
  disabled if reasoning consumes the entire output allowance, preventing a
  successful response with zero report text.

### Upgrade from v0.6

- Pin directly to v0.7.3 and redeploy the heartbeat Worker. No bundle, ledger,
  Durable Object, or dashboard migration is required.
- Existing agents remain unchanged unless they add `github-docs` to their
  `sources:` list. Instances that do not use it still benefit automatically
  from the Anthropic provider resilience fix.
- For cloud docs, add `GITHUB_DOCS_REPO` and optionally
  `GITHUB_DOCS_REF`/`GITHUB_DOCS_PATH`. Private repositories should use a
  dedicated `GITHUB_DOCS_TOKEN` with Contents read-only access; public repos
  need none. Validate through `/docs/check`.
- For local docs, set an absolute `GITHUB_DOCS_LOCAL_PATH`. Mirror ignored
  sensitive or irrelevant paths into `GITHUB_DOCS_EXCLUDE`, because a plain
  filesystem walk does not interpret `.gitignore`.

## [v0.6.x] — read-only external knowledge sources

**Latest tag: v0.6.0 · 2026-07-17**

### Value

v0.6 introduces the source seam: external document stores can be assembled into
an agent's prompt without granting the agent tools or write capability. Agents
opt in through `sources:` frontmatter; missing or unreachable context is stated
explicitly and never aborts the run.

The first adapter is `onedrive`, backed by Microsoft Graph with delegated OAuth,
bounded cabinet traversal, Teams/SharePoint shortcut support, and text-only
reads. The heartbeat Worker exposes bearer-gated `GET /graph/check` for operator
validation.

### Upgrade from v0.5

- Pin to v0.6.0 and redeploy the heartbeat Worker. Existing agents need no
  changes unless they opt into a source.
- To enable `onedrive`, add it to selected agents' `sources:` lists; configure
  the `MSGRAPH_*` vars and read-only OAuth secrets from the Worker template;
  validate with `/graph/check`.
- No bundle, ledger, Durable Object, or dashboard migration is required.

## [v0.5.x] — cloud cognition control and operational hardening

**Latest tag: v0.5.5 · 2026-07-12**

### Value

v0.5 gives cloud instances a second pure-fetch cognition path and a clean
vendor failover control. `anthropic-api` uses subscription OAuth through the
provider chokepoint, while `cognition.overrides` redirects a declared
harness/model at runtime without rewriting agent identity. Cloud eligibility,
reports, and ledger evidence all follow what actually ran.

The mature v0.5 line also captures the first production lessons: the Anthropic
OAuth system-prompt shape is enforced correctly, quota and request-shape errors
are diagnosable, browser authentication works with standards-compliant cookies,
and the dashboard reliably selects the dated hub brief rather than a README or
specialist report.

### Upgrade from v0.4

- Pin to v0.5.5 and redeploy both heartbeat and web Workers to receive the full
  provider and dashboard hardening. No data migration is required.
- `cognition.overrides` is optional; existing declarations continue unchanged.
- To use `anthropic-api`, add `CLAUDE_CODE_OAUTH_TOKEN` as a heartbeat Worker
  secret and declare or override the relevant harness. Validate with a manual
  beat.

## [v0.4.x] — the mesh becomes two-way and observable

**Latest tag: v0.4.2 · 2026-07-11**

### Value

v0.4 adds directions as the second agentic entry point. Discord interactions or
an optional Gmail poll can become a full-context run without keyword routing;
sender allowlists, daily budgets, queued execution, append-only evidence, and
evidence-before-reply ordering remain deterministic.

It also adds the separately credentialed Google-OIDC dashboard and the
workerd-local/live evaluation stack. The completed line preserves failed
direction text in the ledger, sends honest failure replies, diagnoses HTML edge
blocks, and handles concurrent GitHub snapshots without force-pushing.

### Upgrade from v0.3

- Pin to v0.4.2. Merge the `DIRECTION_DO` binding and `v2`
  `new_sqlite_classes` migration into the heartbeat Wrangler config while
  retaining the existing HeartbeatDO `v1` migration, then redeploy.
- Discord directions need `DISCORD_PUBLIC_KEY`; Gmail directions need the
  `DIRECTION_GMAIL_*` vars and `GMAIL_*`/`AGENT_EMAIL` secrets. Both surfaces
  remain optional.
- Deploy `workers/web` separately if the dashboard is desired. It receives only
  its OIDC, session, read-only GitHub, beat-trigger, and allowlist configuration—
  never cognition or persona-channel credentials.

## [v0.3.x] — the cloud execution foundation

**Latest tag: v0.3.0 · 2026-07-11**

### Value

v0.3 establishes the architecture that makes cloud the primary runtime:
`InstanceStore` separates the engine from storage, the GitHub store reads a
private brain as one snapshot and lands one non-force commit, and HeartbeatDO
provides a DST-correct daily alarm on Cloudflare Workers.

Workers-safe core modules and import-hygiene tests isolate Web Platform code
from Node wrappers. `moonshot-api` supplies fetch-based cloud cognition,
`claude-agent-sdk` remains Node-only, and the CLI can address remote brains with
`github:owner/repo#ref`.

### Upgrade from v0.2

- Pin to v0.3.0. Local-only instances need only validate; their bundle and
  ledger formats do not change.
- For cloud execution, push the brain to a private GitHub repo and create its
  private Wrangler config from the heartbeat template. Retain the HeartbeatDO
  binding and `v1` migration; set repo, timezone, and hour vars; add GitHub,
  cognition, delivery, and manual-trigger secrets; then deploy.
- Cloud-scheduled agents must use a harness in `CLOUD_HARNESSES`. Subprocess
  harnesses remain CLI-only and are skipped honestly by cloud heartbeats.

## [v0.2.x] — scheduling, delivery, and a public agent surface

**Latest tag: v0.2.0 · 2026-07-06**

### Value

v0.2 turns individual local runs into an operating rhythm: cadence-aware
heartbeats wake due specialists first and the hub last, delivery channels carry
the resulting brief through Discord, Notion, Gmail, or console, and the live A2A
agent card advertises only currently permitted capabilities.

The release also adds the `heartbeat`, `deliver`, and `card` CLI commands and
adopts Apache-2.0 licensing.

### Upgrade from v0.1

- Pin to v0.2.0 and validate the brain. There is no data migration.
- Delivery is optional. Configure `delivery.channels` and
  `delivery.deliverAgent`, then provide only the selected channels' environment
  variables in the private instance.
- This line is local-only; continue to v0.3 or later for cloud execution.

## [v0.1.x] — the safety and knowledge contract

**Latest tag: v0.1.0 · 2026-07-06**

### Value

v0.1 is the initial public engine: OKF-style concepts and conformance, agent
definitions, the L1–L4 autonomy ladder, constitutional gates, file approvals,
the append-only JSONL ledger, post-run verifiers, and the model-provider
chokepoint.

It includes the CLI for scaffold, validate, run, gates, reports, and templates;
every scaffolded brain must pass the same conformance checker used in normal
operation. Claude Code, OpenCode, and the deterministic fake harness provide the
initial local cognition options.

### Starting here

- There is no earlier tagged instance to migrate.
- Scaffold with `pnpm cli init`, validate the result, and continue through the
  later minor upgrade notes before choosing a production tag.

[Unreleased]: https://github.com/jackzhaojin/anima-mesh/compare/v0.7.3...HEAD
[v0.7.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.7.3
[v0.6.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.6.0
[v0.5.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.5.5
[v0.4.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.4.2
[v0.3.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.3.0
[v0.2.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.2.0
[v0.1.x]: https://github.com/jackzhaojin/anima-mesh/tree/v0.1.0
