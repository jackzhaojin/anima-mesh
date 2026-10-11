# Verification

## PoC-owned environment

After switching to the PoC's own ignored `.env` with `ANTHROPIC_API_KEY`,
typecheck and all six offline tests passed. A live run with exported
`ANTHROPIC_API_KEY` and `CLAUDE_API_ENV_FILE` unset confirmed the default local
file works: `ANTHROPIC_API_KEY` authentication, one successful Read, exact
response match, two turns, 1,908 ms, $0.003715, and 2,995 / 144 input / output
tokens. The local env file has owner-only permissions (`600`).

## Initial verification before the environment migration

Live test on 2026-10-10 using `CLAUDE_API_KEY` from the existing, git-ignored
sibling `chat-cli/.env`, mapped to `ANTHROPIC_API_KEY` for the SDK subprocess.
No subscription token was passed to the subprocess.

| Check | Observed result |
| --- | --- |
| SDK | `@anthropic-ai/claude-agent-sdk` 0.3.207 |
| Resolved model | `claude-haiku-4-5-20251001` |
| SDK-reported authentication source | `ANTHROPIC_API_KEY` |
| Successful Read calls | 1 |
| Exact response matches generated fixture | true |
| Agent turns | 2 |
| SDK-reported duration | 2,017 ms |
| SDK-reported cost | $0.003719 |
| Input / output tokens | 2,999 / 144 |
| Result | PASS |

`pnpm typecheck` passed. `pnpm test` passed all five offline tests. The live
check exercised the real SDK runtime, Anthropic authentication, the Read tool,
the agent continuation, and final response validation. Costs and timing are
observations from this run, not guarantees for subsequent runs.

This verifies the isolated PoC only. The engine's existing subscription-based
provider was not changed or exercised.

A second live run after tightening the auth assertion to require the exact
`ANTHROPIC_API_KEY` source also passed: one Read, exact response match, two
turns, 1,862 ms, $0.003701, and 2,996 / 141 input / output tokens.
