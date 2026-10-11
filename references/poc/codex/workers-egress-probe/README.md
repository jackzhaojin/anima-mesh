# workers-egress-probe

Does the ChatGPT-plan Codex endpoint answer a Cloudflare Worker? This probe
runs the `openai-codex` harness's exact request shape **on Cloudflare's
edge** (`wrangler dev --remote`, nothing deployed) and reports, for each
host, whether it answered with JSON (reachable) or an HTML block page.

## Result (2026-10-11): blocked

| From the Worker | Result |
|---|---|
| `chatgpt.com/backend-api/codex/responses` (plain and web_search, with or without a User-Agent) | **403 HTML**, "Unable to load site … If you are using a VPN, try turning it off", naming the Worker's egress IP |
| `auth.openai.com/oauth/token` (empty grant) | 400 JSON, reachable |
| `api.openai.com/v1/models` (no key) | 401 JSON, reachable |

So `openai-codex` is laptop-tier. See
[the learning](../../../../docs/learnings/2026-10-11-chatgpt-codex-blocks-workers.md).

## Run it again

It uses an **access token only**, read from your Codex login and never
refreshed, so it cannot rotate or spend that login. Wrangler needs Node 22+.

```bash
cd references/poc/codex/workers-egress-probe
node -e 'const t=require(process.env.HOME+"/.codex/auth.json").tokens; require("fs").writeFileSync(".dev.vars",`CODEX_ACCESS_TOKEN=${t.access_token}\nCODEX_ACCOUNT_ID=${t.account_id}\n`,{mode:0o600})'
npx wrangler@4 dev --remote --port 8799    # then, in another shell:
curl -s http://127.0.0.1:8799          # add ?ua=1 to send a User-Agent
rm .dev.vars                            # git-ignored, but don't leave a token lying around
```

`edgeBlocked: true` (an HTML body) means the network class is refused before
the API is reached. A JSON 401/400 means the host is reachable and only
auth or shape would need work.
