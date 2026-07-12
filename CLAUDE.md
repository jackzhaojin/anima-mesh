# CLAUDE.md — anima-mesh (public engine)

Working agreements for AI sessions in this repo. Read [README.md](README.md)
first for what AnimaMesh is, then [docs/README.md](docs/README.md) — the
operator's shelf, with a read order for new sessions; this file is about how
to work on the code.

## The one hard rule

**This repo is public and instance-agnostic.** It must never name, reference,
or leak any particular company, person's private data, or agent persona that
uses the engine. Identity is configuration (`{{PLACEHOLDER}}` vars in
templates, `animamesh.config.json` in instances) — never a literal in engine
code, templates, tests, or docs. Before any commit: scan the diff for instance
names, real emails, and secrets. `.env*` files never enter this repo.
When unsure whether knowledge is engine-general or instance-specific, run the
checklist in [docs/engine-vs-instance.md](docs/engine-vs-instance.md).
Platform lessons learned in production go in [docs/learnings/](docs/learnings/README.md)
— symptom-first, with evidence, de-identified.

## Commands

```bash
pnpm verify        # typecheck + full test suite + worker typecheck — green before every commit
pnpm test          # vitest run
pnpm typecheck     # tsc --noEmit (covers src/ AND test/)
pnpm typecheck:worker  # tsc -p workers/heartbeat (Workers types)
pnpm cli <cmd>     # run the CLI from source (tsx src/cli.ts)
pnpm build         # emit dist/ (tsconfig.build.json)
```

## Architecture in one screen

```
src/
  okf/          frontmatter parse/serialize · bundle loader · conformance
                (profiles: "okf" base, "animamesh" adds constitution/agent rules)
  ledger/       append-only JSONL ledger + integrity/completeness assertions
  gates/        ApprovalStore (file-based needs-you) · gatekeeper (constitution
                gates + ladder enforcement — GateViolation on any breach)
  autonomy/     L1→L4 ladder; external actions ALWAYS gated, even at L4
  agents/       AgentConcept from concept files · D11 commercial dual-gate
  providers/    THE CHOKEPOINT: AgentWorkerProvider seam + registry.
                index.ts is the Workers-safe core (moonshot-api, anthropic-api,
                fake, CLOUD_HARNESSES, resolveProvider(harness, ctx?));
                node-providers.ts registers the subprocess ones on import
                (claude-code, claude-agent-sdk, opencode) — Node entrypoints only.
                anthropic-api = subscription OAuth over plain fetch; its system
                prompt SHAPE is load-bearing (docs/learnings/2026-07-12)
  instance/     config loading/resolution · THE STORAGE SEAM: store.ts
                interface, store-fs (local), store-github (tarball read,
                one commit per flush, never force) · tar.ts · github-auth.ts
  harness/      run-core/heartbeat-core (Workers-safe; store required;
                tz-aware dates; cloudTier skips non-CLOUD_HARNESSES; the
                EFFECTIVE harness — after config cognition.overrides — is
                what's gated and recorded) with run.ts/heartbeat.ts Node
                wrappers · direction-core (inbound message → ONE agentic run;
                direction-* ledger actions so directions never eat the daily
                dedup; dot-named artifacts so brief delivery skips them) ·
                verifiers(-core)
  channels/     delivery registry (registry.ts, Workers-safe: discord/notion/
                gmail/console, injected env) · index.ts fs wrapper
  a2a/          agent card: card-core.ts pure assembly · card.ts fs wrapper
  init/         interview (file/flags/interactive/agentic) · scaffoldBrain
                (acceptance test: its own output must pass conformance)
  cli.ts        init/validate/run/gate/report/templates — main(argv) → exit
                code, driven in-process by tests; `github:owner/repo#ref`
                instance scheme runs against a remote brain
workers/heartbeat/  the cloud tier: Worker + HeartbeatDO (DST-correct daily
                alarm, beat mutex) + DirectionDO (direction queue, Ed25519
                Discord interactions, optional Gmail poll, daily budget) —
                own workspace, pure Web platform; deploy config lives in the
                INSTANCE repo
workers/web/    the principal's dashboard Worker: in-Worker Google OIDC,
                email allowlist re-checked per request, narrow env (no
                cognition/persona secrets) — see workers/web/README.md
templates/agents/   the shipped roster (see templates/README.md)
test/               regression suite (see test/README.md)
references/poc/     read-only PoC examples — NOT engine code, excluded from tsconfig
```

## Design invariants (do not regress)

1. **Safety in code, never prompts.** Gates, ladder, ledger, and verifiers are
   deterministic. If a safety property is only stated in a prompt, it doesn't
   exist.
2. **Deterministic code is confined to four jobs**: heartbeat plumbing, gate
   enforcement, ledger appends, verifiers. Don't add scripted business logic
   between wake-up and gate — that space belongs to model judgment.
3. **Providers only via the chokepoint.** New model/harness = new
   `AgentWorkerProvider` adapter + registry entry. Never scatter model calls.
4. **The ledger is append-only.** No truncation, no rewrites, anywhere.
5. **Conformance is the contract.** Anything that changes bundle expectations
   must update `okf/conformance.ts` AND its tests AND `init/scaffold.ts`
   together — init output must always pass the current checker.
6. **Every safety property gets a behavioral test.** A gate without a test
   proving it throws is not a gate.
7. **The Worker bundle is pure Web platform.** Nothing reachable from
   `workers/heartbeat/src/index.ts` may import `node:*`, subprocess
   providers, or fs-backed modules — `test/workers-imports.test.ts` enforces
   it. New shared code goes in a `*-core.ts` module; Node conveniences wrap
   it. The GitHub store never force-updates a ref, and global `fetch` must be
   wrapped, not aliased (Workers reject rebound `this`).

## Conventions

- ESM throughout (`"type": "module"`): imports use `.js` suffixes, no
  `require()`, no `__dirname` (use `fileURLToPath(import.meta.url)`).
- TypeScript strict + `noUncheckedIndexedAccess`; tests are typechecked too.
- Runtime deps: currently only `yaml`. Adding one needs a strong reason.
- Tests build fixtures in temp dirs via `test/helpers.ts` (`makeTree`,
  `concept`, `minimalAnimaMeshFiles`) — no static fixture files, no network,
  no real model calls (use `FakeProvider`).
- Real-harness changes (claude-code/opencode adapters) can't run in CI —
  verify them against a live instance and record findings in the commit body.

## Releases

`private: true` guards against accidental npm publish (name unconfirmed).
Release = git tag `vX.Y.Z`; instances pin by tag and upgrade by deliberate ref
bump.
