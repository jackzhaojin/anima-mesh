# Anthropic OAuth gateway: the identity sentence must be its own system block

**Symptom:** every real agent run through the `anthropic-api` harness fails
with `HTTP 429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}`
— a bare body with **no `anthropic-ratelimit-*` headers** — while small
hello-world requests with the same token succeed from the same egress, and
quota utilization reads 13–25% "allowed" throughout. Deterministic, not
transient: retries never help.

**The rule: when authenticating to `api.anthropic.com/v1/messages` with a
subscription OAuth token (`sk-ant-oat…`), the `system` field must be an array
whose FIRST block is exactly
`{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}`
— its own entry, nothing appended. Additional instructions go in subsequent
blocks.**

## Mechanism

The gateway runs a classifier on every OAuth-token request to decide whether
it draws from the subscription or gets routed to the **overage billing lane**.
When overage is disabled on the org (the common case), overage-routed requests
are rejected with the bare 429 above. The classifier tolerates a sloppy system
prompt on *small* requests — which is exactly what makes this trap vicious:
every smoke test passes, then the first real prompt (tens of KB of agent
context) fails in production.

Diagnostic signature worth memorizing: **a 429 carrying quota headers
(`anthropic-ratelimit-unified-5h-status` etc.) is real rate limiting; a 429
with no quota headers is a request-shape rejection.** A successful response's
`anthropic-ratelimit-unified-overage-status: rejected` +
`overage-disabled-reason: org_level_disabled` headers show the lane exists.

## Evidence (live bisect, 2026-07-12, real ~27k-char agent prompt)

| Variant | system field | Extra headers | Result |
|---|---|---|---|
| B | `"<identity>\n\n<app note>"` (one string) | — | **429** bare |
| E | same, but generic filler prompt of identical length | — | **429** bare (content-independent) |
| C | same string | full CLI fingerprint (`user-agent`, `x-app`, beta pair) | **429** bare (headers don't help) |
| D | `[{identity}, {app note}]` blocks | full CLI fingerprint | **200** |
| F | `[{identity}, {app note}]` blocks | `anthropic-beta: oauth-2025-04-20` only | **200** (block shape alone is sufficient) |

Same results from residential and Cloudflare Workers egress — the network
path is irrelevant. No user-agent spoofing is needed or used.

## Where the engine encodes it

- `src/providers/anthropic-api.ts` — `SYSTEM_BLOCKS` array; bare 429s (no
  quota headers) raise an error naming the request-shape rejection; 429s with
  quota headers report window status + reset time.
- `test/providers-anthropic.test.ts` — regression tests pin the exact first
  block and both 429 diagnostic messages.

## References

- [anthropics/claude-code#40515](https://github.com/anthropics/claude-code/issues/40515)
  — independent report of the block-shape validation (their repro saw 400s;
  large-prompt overage routing yields the 429 form).
- [NousResearch/hermes-agent#53212](https://github.com/NousResearch/hermes-agent/issues/53212)
  — the overage-lane classifier observed by another agent harness.
