# Claude API PoC

A standalone TypeScript proof of concept using `@anthropic-ai/claude-agent-sdk`
with `CLAUDE_API_KEY`. It maps that value to the SDK's `ANTHROPIC_API_KEY` in
the subprocess environment. It does not change AnimaMesh's engine provider.

## Run

Requires Node.js 20.12+ and pnpm. From the repository root:

```sh
cd references/poc/claude/claude-api-poc
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:live
```

`pnpm start` runs the same live test. Live runs use the Anthropic API and incur
API usage charges. The default model is `haiku`; override with
`CLAUDE_API_MODEL=sonnet pnpm start` if desired. The SDK budget is $0.10, the
turn limit is three, and the timeout is two minutes. The budget is checked by
the SDK between turns, not a guaranteed billing ceiling for an in-flight call.

The key is loaded in this order:

1. The file explicitly selected by `CLAUDE_API_ENV_FILE` (relative to the shell's
   working directory, or absolute).
2. An exported `CLAUDE_API_KEY`.
3. The repository root's `.env.local`, if it exists.
4. The sibling `../chat-cli/.env`.

The selected file must contain a nonempty `CLAUDE_API_KEY`. No other file
variables are imported. Default file paths are resolved relative to this
script, so changing the shell's working directory does not break them.
Credentials stay in their existing ignored file; no key is copied or printed.
For an explicit source:

```sh
CLAUDE_API_ENV_FILE=../chat-cli/.env pnpm start
```

## What PASS proves

The runner creates a temporary file containing a random challenge, then asks
Claude to read that file and return its contents. The challenge is not included
in the prompt. PASS requires all of the following:

- The SDK reports `ANTHROPIC_API_KEY` as its authentication source.
- A successful `Read` tool hook is observed.
- The SDK returns a successful result with no API error.
- The final response matches the random challenge exactly.

The output includes the resolved model, key source (never the key), successful
read count, turns, cost, duration, and token usage. Any failure exits nonzero.

The child process receives an allowlisted environment and a fresh Claude config
directory. OAuth credentials, third-party provider switches, and inherited API
endpoint overrides are excluded. Settings and external MCP discovery are
disabled. The only available built-in tool is `Read`, and a `PreToolUse` hook
denies every path except the generated fixture. No permission bypass is used.
The agent works in a temporary directory; session persistence is disabled and
temporary files are cleaned up after success or failure.

`pnpm test` runs offline checks for credential loading, auth/environment
isolation, tool restrictions, and error redaction. It makes no model calls.

If authentication fails, check the key in the selected env file. If the API
reports insufficient credits or model access, resolve that account condition
and rerun. A missing key fails before the SDK starts and never falls back to
a Claude subscription login.

## References

- [Anthropic Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

The SDK is pinned to `0.3.207`, matching the engine dependency installed when
this PoC was created. Its bundled Claude runtime requires a local process;
this example is not a Cloudflare Workers adapter.
