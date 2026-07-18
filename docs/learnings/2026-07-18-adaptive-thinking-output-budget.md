# Adaptive thinking spends your max_tokens — a small budget yields ZERO text

**Symptom**: an agent run via the `anthropic-api` harness fails with

```
anthropic-api → response contained no text blocks (stop_reason: max_tokens, blocks: thinking)
```

HTTP 200, valid JSON, but `content` holds a single `thinking` block and no
`text` at all. Small prompts succeed; a long, hard prompt (two document-store
listings + a reconciliation task) fails every time.

**The rule: on models where adaptive thinking is on by default
(claude-sonnet-5), `max_tokens` caps thinking + text COMBINED — budget for
both or the model can think its entire allowance away and return no text.**

## Evidence (2026-07-18, live bisect)

| Probe | max_tokens | Prompt | Result |
|---|---|---|---|
| "Say hello" | 8192 | trivial | 200, `text`, 6 output tokens |
| 14K-token filler prompt | 8192 | easy | 200, `text`, `thinking_tokens: 0` |
| Real agent prompt (two corpora, reconciliation task) | 8192 | hard | 200, `blocks: thinking`, `stop_reason: max_tokens`, no text |

The task's difficulty — not the prompt's size — drives thinking depth.
Omitting the `thinking` parameter does NOT mean thinking-off on
claude-sonnet-5: it means *adaptive*, and adaptive scales with task
difficulty. The failure only appears when real work arrives, which is why a
provider can pass every smoke test and then die on its first hard prompt.

## Where the engine encodes it

- `src/providers/anthropic-api.ts` — `max_tokens: 16384` (room to think AND
  write, still safe for non-streaming), plus a one-shot fallback: a
  thinking-only `max_tokens` response retries once with
  `thinking: {type: "disabled"}` (accepted on sonnet-5/opus-4.8; models that
  reject it fail loud on the 400).
- `test/providers-anthropic.test.ts` — "retries once with thinking disabled
  when thinking eats the whole output budget" and the fail-loud sibling.
- The error message names `stop_reason` and block types precisely so this
  failure is greppable — a bare "malformed response" was undiagnosable.

Related: [2026-07-12-anthropic-oauth-gateway.md](2026-07-12-anthropic-oauth-gateway.md)
(same endpoint, different trap).
