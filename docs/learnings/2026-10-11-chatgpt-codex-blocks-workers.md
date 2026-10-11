# chatgpt.com blocks Cloudflare Workers egress: subscription Codex is laptop-tier

**Symptom:** the `openai-codex` request (ChatGPT-plan Codex Responses
endpoint, `POST https://chatgpt.com/backend-api/codex/responses`) works from
a laptop in about 1-2 s, but from a Cloudflare Worker every request returns
`HTTP 403` with an HTML page whose visible text is:

> Unable to load site. Please try again later. If you are using a VPN, try
> turning it off. Check the status page for information on outages.
> [IP:2a06:98c0:3600::103 | Ray ID:…]

The IP it names is the Worker's egress address (Cloudflare's Workers range).

**The rule: ChatGPT-subscription inference cannot be called from a
Cloudflare Worker. Keep `openai-codex` out of `CLOUD_HARNESSES`; cloud
cognition stays on hosts that answer Workers.** This is the
[2026-07-11 lesson](2026-07-11-workers-egress-waf.md) again, and this time
the integration was built before the probe. Probe first.

## Evidence

Probe: `references/poc/codex/workers-egress-probe`, run with
`wrangler dev --remote` (code executes on Cloudflare's edge, colo `YYZ`),
2026-10-11. The Codex calls used a valid, unexpired ChatGPT-plan access
token, read-only (no refresh sent).

| Request from the Worker | Result |
|---|---|
| Codex endpoint, plain prompt | 403, HTML "Unable to load site" |
| Codex endpoint, with `tools: [{type: "web_search"}]` | 403, same page |
| Same, plus `User-Agent: anima-mesh/2.0 (+repo url)` | 403, same page |
| Same, plus a Codex-CLI-shaped `User-Agent` | 403, same page |
| `POST https://auth.openai.com/oauth/token` (empty grant) | 400 JSON `missing_required_parameter` — reachable |
| `GET https://api.openai.com/v1/models` (no key) | 401 JSON — reachable |

So the block is on the subscription host only, keyed on egress IP, and
independent of headers. The metered OpenAI API host and the OAuth token host
both answer Workers.

The same request shape from the laptop (same day): 200 with streamed output
on `gpt-5.5` and `gpt-6-luna`, and server-side `web_search` ran one search
inside the same response (`response.web_search_call.*` events).

## What does not get around it

- **opencode with its ChatGPT login.** It calls the same
  `chatgpt.com/backend-api/codex` endpoint, so it meets the same block. It is
  also a subprocess, which no Worker hosts.
- **Headers.** Shown above.
- **Cloudflare Containers** were not probed. Their egress most likely leaves
  from Cloudflare ranges too; probe before building on them.

## Where the engine encodes it

- `src/providers/index.ts` — `openai-codex` is absent from `CLOUD_HARNESSES`,
  with this file cited.
- `test/providers-moonshot.test.ts` and `test/providers-codex.test.ts` assert
  the absence; `test/cognition-override.test.ts` proves a cloud beat skips an
  `openai-codex` agent with a stated reason instead of failing daily.
- The HTML-body check in `src/providers/openai-codex.ts` names the block page
  as "network blocked" if the provider is ever pointed at Workers anyway.
