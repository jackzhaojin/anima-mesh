# Verification

## Claude Code cloud container

Live test on 2026-10-11 from a Claude Code cloud session (Anthropic-hosted
environment, Full network access). The key was stored as an ordinary
environment variable named `POC_ANTHROPIC_API_KEY` and mapped on the command:
`ANTHROPIC_API_KEY="$POC_ANTHROPIC_API_KEY" pnpm test:live`.

| Check | Observed result |
| --- | --- |
| Resolved model | `claude-haiku-4-5-20251001` |
| SDK-reported authentication source | `ANTHROPIC_API_KEY` |
| Successful Read calls | 1 |
| Exact response matches generated fixture | true |
| Agent turns | 2 |
| SDK-reported duration | 1,698 ms |
| SDK-reported cost | $0.003525 |
| Input / output tokens | 2,915 / 122 |
| Result | PASS |

`pnpm install --frozen-lockfile`, `pnpm typecheck`, and all six offline tests
also passed in a cloud session. What we learned getting there:

- Network secrets cannot carry this key. The cloud environment docs list
  `api.anthropic.com` among the hosts the agent proxy never attaches a secret
  to, and say such a key stays in an environment variable instead.
- A variable saved as `ANTHROPIC_API_KEY` never appeared in the session's
  environment. Whether the platform withholds that name or the save simply
  landed after the VM read its environment was not isolated; a
  non-`ANTHROPIC_` name avoids the question and keeps the session's own Claude
  Code from seeing the key under its real name.
- Environment changes reach a session only when its VM starts, restores from
  idle, or is rebuilt. A new session picks them up immediately.
- No CA handling is needed. The container's TLS-intercepting proxy CA is in
  the system trust store, which the SDK's bundled runtime and `curl` use, so
  the PoC's allowlisted child environment reaches the API as is. (Plain
  Node's `fetch` with the same stripped environment fails with
  `SELF_SIGNED_CERT_IN_CHAIN`, because Node uses its own CA bundle unless
  `NODE_EXTRA_CA_CERTS` is passed.)

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
