# test/ — the regression suite

`pnpm verify` = typecheck (src **and** test) + this suite. It is the
contract: green before every commit, no exceptions. No network, no real model
calls, no static fixtures — everything builds in temp dirs via
`helpers.ts` and runs against `FakeProvider`.

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
