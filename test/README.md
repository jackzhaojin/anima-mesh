# test/ — the regression suite

`pnpm verify` = typecheck (src **and** test) + this suite + the Worker's
workerd suite (`pnpm test:worker`). It is the contract: green before every
commit, no exceptions. No network, no real model calls, no static fixtures —
everything builds in temp dirs via `helpers.ts` and runs against
`FakeProvider`.

## What each file guarantees

- **okf.test.ts** — frontmatter round-trips; malformed YAML throws (never
  silently repaired); bundle walking is deterministic and skips dot-dirs;
  conformance catches missing index/log, missing `type`, non-immutable
  constitutions, undated decisions, agent concepts without chokepoint fields;
  broken links warn without failing.
- **ledger-gates.test.ts** — the safety layer as behavior: ledgers only grow;
  corruption is detected; approvals are terminal; the ladder blocks
  above-level actions; gated types without a *matching approved* record throw
  (pending, denied, and wrong-type all rejected); L3 whitelists enforced;
  constitution gate lists union with the floor, never replace it.
- **harness.test.ts** — a full heartbeat end-to-end: report artifact with
  frontmatter, three ledger entries in order, all verifiers green; prompts are
  assembled from the bundle (never recall) and include latest mesh reports +
  pending approvals; commercial agents refuse to run without the dual gate;
  a conformance break in the bundle fails the run.
- **init.test.ts** — the PRD acceptance test: empty dir → conformant brain
  (re-checked independently, not trusting the scaffolder); placeholders fully
  substituted; non-empty targets refused; a scaffolded brain immediately
  completes a run; agentic enrichment adopts valid suggestions, strips unknown
  agents, survives fenced/prose JSON, falls back on garbage, and never
  overrides an explicit human choice.
- **cli.test.ts** — every command driven in-process (`main(argv)` → exit
  code): init/validate/run/gate/report/templates, including failure exits.
- **channels.test.ts / heartbeat-card.test.ts** — delivery channels against
  mocked fetch (env injection, per-channel auth failures); heartbeat
  due/skip/dedup semantics; the agent card excludes dual-gated agents and
  declares `streaming: false`.
- **providers-moonshot.test.ts / providers-claude-sdk.test.ts** — the API
  providers against mocked fetch / a mocked SDK module (never a subprocess):
  request shape, retry/backoff, timeouts, env-binding, no key leakage;
  `CLOUD_HARNESSES` contains exactly the fetch-only harnesses.
- **store-github.test.ts** — the remote store against a scripted GitHub API
  with an in-test fixture tarball: read-your-writes, one commit per flush,
  `force:false` + exactly one conflict retry, User-Agent on every call, and
  a full `runAgent` over the store landing report + 3 ledger lines in ONE
  commit. (`store-github-integration.test.ts` hits a real repo branch, gated
  on `GITHUB_STORE_IT=1`.)
- **workers-alarm-time.test.ts / workers-imports.test.ts** — DST-correct
  alarm math across both US transitions; the Worker import-graph walker that
  fails on any `node:*` or subprocess module.

## workers/heartbeat/test/ — the Worker in real workerd

`pnpm test:worker` (included in `pnpm verify`) runs vitest inside workerd
via `@cloudflare/vitest-pool-workers`: the deployed-shape Worker with its
Durable Object, all outbound services (GitHub, Kimi, Discord) scripted with
`fetchMock` — one-shot interceptors with exact call counts, so the mock plan
IS the expected traffic (`assertNoPendingInterceptors` in every afterEach).

- **router.test.ts** — /healthz sanitization (counts only, never failure
  strings), Bearer auth on /beat, first-arm idempotence, the public card,
  404-by-default.
- **heartbeat-do.test.ts** — the alarm re-arms in `finally` even when the
  beat crashes (with the failure DM proven); alarm lands at the configured
  hour in the configured timezone; the beat mutex (fresh lock skips, stale
  lock stolen, lock cleared after).
- **beat-e2e.test.ts** — a full cloud beat end-to-end in workerd: snapshot →
  due decision → Kimi cognition → report + ledger → ONE commit (force:false,
  `animamesh-cloud`) → Discord DM; same-day dedup; an agent-level provider
  failure that the beat survives and reports.

Pinned to vitest 3.2.x + pool 0.12.x (the last vitest-3 line, matching this
suite). The 0.13+ pool requires vitest 4 and replaces defineWorkersConfig and
fetchMock — migrate deliberately with Cloudflare's shipped codemod.
Two pool quirks are handled in `test/fixtures.ts`/config comments: isolated
storage can't pop live SQLite sidecars (so tests wipe DO state explicitly
instead), and the first stub call after a module reload needs one retry.

## Adding tests

1. New safety property ⇒ new behavioral test that proves the failure mode
   throws/fails. A gate without a test is not a gate.
2. Build fixtures with `makeTree`/`concept`/`minimalAnimaMeshFiles` from
   `helpers.ts`; clean up in `afterEach`.
3. Model interactions go through `FakeProvider` with a handler — assert on
   `fake.calls` for prompt-content expectations.
4. Real-harness behavior (claude-code/opencode) is verified against a live
   instance manually; record findings in the commit body, then encode the
   *deterministic* part as a test (see the per-cwd opencode server fix).
