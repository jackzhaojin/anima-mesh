# codex hello world

This directory is the minimal Codex SDK baseline POC.

## Purpose

- Keep one very small working example under `references/poc/codex`.
- Use it as the starting point for more advanced POCs in later folders.

## What This Uses

- Package: `@openai/codex-sdk`
- Runtime: Node.js 18+
- Local auth: the existing Codex CLI login on this machine

The SDK wraps the local `codex` CLI. In this environment, `codex login status` reports `Logged in using ChatGPT`, so this hello-world uses that login path without passing an explicit API key.

## Files

- `src/hello.js`: starts a Codex thread, asks for a simple hello response, and prints the final text.

## Run

```bash
cd /Users/jackjin/dev/continuous-agent-develop/references/poc/codex/hello-world
npm run hello
```

## Notes

- This is intentionally minimal.
- Future Codex POCs can live alongside it under `references/poc/`.
- For more advanced work, we can add separate folders for file edits, streaming, resume-thread flows, and side-by-side Codex SDK vs Agents SDK comparisons.

## References

- https://developers.openai.com/codex/sdk
- https://developers.openai.com/codex/auth
- https://developers.openai.com/codex/quickstart
