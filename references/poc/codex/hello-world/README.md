# codex hello world

This directory is the minimal Codex SDK baseline POC.

## Purpose

- Keep one very small working example under `references/poc/codex`.
- Use it as the starting point for more advanced POCs in later folders.

## What This Uses

- Package: `@openai/codex-sdk` 0.162.1
- Runtime: Node.js 18+
- Local auth: the existing Codex CLI login on this machine

The SDK launches its bundled Codex CLI and reuses the saved local login. On
2026-10-11 (UTC), the bundled CLI reported `Logged in using ChatGPT`, and the
live example returned `Hello from Codex.` without an explicit API key. This
uses ChatGPT plan access; the example does not implement a separate OAuth flow.

## Files

- `src/hello.js`: starts a Codex thread, asks for a simple hello response, and prints the final text.

## Run

```bash
cd references/poc/codex/hello-world
npm ci
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
