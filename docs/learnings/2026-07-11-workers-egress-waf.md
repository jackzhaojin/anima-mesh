# Some vendor edges WAF-block Cloudflare Workers egress entirely

**Symptom:** a provider that works perfectly from a laptop returns
`HTTP 403` with an **HTML block page** (`<!DOCTYPE html>…`) when called from
a Cloudflare Worker — on every request, regardless of API key validity,
headers, or payload. The JSON API was never reached; the vendor's edge
rejected the connection class.

**The rule: a vendor's API being reachable from your machine proves nothing
about Workers egress. Probe from a real deployed Worker before building a
cloud integration on any endpoint — and treat an HTML error body as "network
class blocked", never as an API error.**

## Mechanism

Some vendor edges (WAF/anti-bot layers) block requests originating from
Cloudflare Workers as a class. The `CF-Worker` request header that Cloudflare
appends to Workers subrequests cannot be spoofed or removed, so there is no
client-side fix — header changes, user-agent changes, and key rotation all
land on the same block page. The same vendor may serve *different hostnames
with different edge policies*: in the 2026-07-11 case, one subscription
endpoint hard-blocked Workers while the same vendor's open-platform hostname
answered Workers requests with a normal JSON 401.

## How to probe (10 minutes, before any build)

Deploy a throwaway Worker that fetches the candidate endpoint and returns
status + first bytes of body + whether the body starts with `<`. Run the
exact production request shape. A JSON error (401/400) means the API is
reachable and only auth/shape needs work; an HTML body means pick another
endpoint or another vendor — no amount of engineering on your side fixes it.

## Where the engine encodes it

- `src/providers/anthropic-api.ts` and `src/providers/moonshot-api.ts` —
  error paths detect an HTML body and raise
  `(HTML block page from the endpoint's edge — this network is blocked from
  calling the endpoint; the API itself was never reached)` instead of spraying
  markup into ledgers and chat replies.
- `test/providers-anthropic.test.ts` — regression test pins the block-page
  naming (and that raw HTML never leaks into error messages).
- Instances can reroute cognition without code changes via
  `animamesh.config.json → cognition.overrides` (declared harness → actually
  executed harness), which is how a mesh survives a vendor edge turning
  hostile between one day and the next.
