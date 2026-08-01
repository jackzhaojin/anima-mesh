# Non-streaming Messages calls hard-cap generation at ~100s (HTTP 524)

**Symptom:** a scheduled cloud beat fails with
`anthropic-api → HTTP 524: error code: 524` after roughly five minutes —
three attempts of ~100 seconds each plus the 2s/8s retry delays. Smaller
agents on the same beat succeed; the one with the largest prompt (and
therefore the longest generation) fails every attempt. Deterministic for
that prompt size, invisible below it.

**The rule: `api.anthropic.com` sits behind Cloudflare, and Cloudflare's
edge returns 524 when the origin has not COMPLETED an HTTP response within
~100 seconds. A non-streaming `/v1/messages` call buffers the entire
generation server-side before the first response byte, so the edge's clock
runs for the whole generation — no client-side `timeoutMs` can help, and
retrying makes it worse (each retry burns a full generation against quota
and hits the same wall). Always request `stream: true` and reassemble the
SSE events.** Streaming sends `message_start` within seconds, so the edge
sees a live response no matter how long the generation runs.

Context that made it bite (2026-08-01): an instance grew a hub agent's
prompt substantially (declared `reads:` inlining ~50K chars, engine
v0.13.0), and adaptive thinking plus a 16K `max_tokens` budget pushed
end-to-end generation past 100s. The provider had been non-streaming since
birth; every earlier run simply finished under the limit.

Reassembly fidelity matters beyond text blocks:

- A `pause_turn` continuation replays the assistant content verbatim, so
  `server_tool_use` inputs must be rebuilt from `input_json_delta` frames
  and thinking signatures from `signature_delta` — a lossy reassembly
  silently restarts a web sweep from nothing.
- A stream that ends without `message_stop` is a CUT generation, not a
  short one. Treat it (and mid-stream `error` events) as retryable like a
  5xx, and fail loud after the retry budget — never return the fragment as
  a clean report.
- Keep accepting plain JSON bodies when the response is not
  `text/event-stream`: it is the natural test seam, and a gateway that
  ignores `stream` degrades gracefully instead of breaking parsing.

Where it lives: `src/providers/anthropic-api.ts` (`consumeSse`,
`readMessage`), tests in `test/providers-anthropic.test.ts`
("streamed responses"). Shipped in v0.15.0.
