# GitHub 403s UA-less calls — and Workers' fetch sends no User-Agent

**Symptom**: a GitHub REST call that works from curl and from Node fails from
a Cloudflare Worker with

```
403 Request forbidden by administrative rules.
Please make sure your request has a User-Agent header.
```

Same endpoint, same token, same JSON — only the runtime differs. Nothing else
in the request looks wrong, and the token's scopes check out everywhere.

**The rule: GitHub's API rejects any request without a `User-Agent` header,
and Workers' `fetch` — unlike curl and Node's undici — adds no default one.
Every GitHub call made from Workers-safe code must set `User-Agent`
explicitly.**

## Evidence (2026-07-18, live)

| Caller | Default UA? | Result |
|---|---|---|
| curl | `curl/8.x` | 200 |
| Node 22 (undici) | `node` | 200 |
| Cloudflare Worker `fetch` | *(none)* | 403 "make sure your request has a User-Agent header" |
| Worker `fetch` + `"User-Agent": "animamesh"` | explicit | 200 |

The trap compounds during development: local tests run on Node, where the
default UA masks the bug entirely — the failure appears only on first deploy.
GitHub documents the requirement
([REST docs: user agent required](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#user-agent))
but returns it as a generic 403, which reads like an auth or permissions
failure and sends the investigation toward the token.

## Where the engine encodes it

Every GitHub-touching module sets an explicit UA, each with a pointer here:

- `src/instance/store-github.ts` — the brain store (tarball reads, commit
  writes); `test/store-github.test.ts` "sends a User-Agent on every request".
- `src/instance/github-auth.ts` — GitHub App installation-token mint;
  `test/github-auth.test.ts` asserts the header on the mint call.
- `src/sources/github-docs.ts` — the docs corpus source;
  `test/github-docs.test.ts` "always sends a User-Agent — Workers' fetch adds
  none and GitHub 403s without one".
- `src/defects/report-core.ts` — public defect-issue filing.

A new GitHub call path added to the engine must do the same — the tests above
are the pattern to copy.

Related: [2026-07-11-workers-egress-waf.md](2026-07-11-workers-egress-waf.md)
(a different way Workers egress differs from your laptop).
