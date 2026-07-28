# codex pocs

This folder groups Codex SDK proofs of concept in one place, similar to `references/poc/claude`.

## Available POCs

- `hello-world`: the smallest possible Codex SDK example.
- `streaming-tools-poc`: a more advanced example that streams events, surfaces tagged item types, and demonstrates command and file-change activity.

## Notes

- Each POC is its own standalone Node project.
- The local Codex CLI login is reused by these examples.
- Future Codex POCs should be added as sibling folders here instead of separate top-level `references/poc/*` directories.

## Keep `@openai/codex-sdk` current

The SDK ships its own `codex` binary (~270 MB) under
`node_modules/@openai/codex-darwin-arm64/vendor/`; it does **not** use the
`codex` on your `PATH`. Two consequences:

- `^0.x` ranges do not float across minor versions — `^0.118.0` resolves only
  to `0.118.x`. Bump the pin deliberately.
- A stale vendored binary can get blocked by macOS. On 2026-07-27 the
  `0.118.0` binary (Developer ID `OpenAI, L.L.C.`, signed Mar 2026) was
  SIGKILLed by XProtect on exec and moved to Trash, surfacing as
  `Codex Exec exited with signal SIGKILL` plus a `node_modules` tree that
  looked corrupt because the binary kept disappearing. The signature was
  valid — Apple had blocklisted that build. Upgrading to `0.145.0`
  (Developer ID `OpenAI OpCo, LLC`, signed Jul 2026) resolved it.

If you see SIGKILL from `CodexExec`, check whether the vendored binary still
exists after the run before suspecting your code.
