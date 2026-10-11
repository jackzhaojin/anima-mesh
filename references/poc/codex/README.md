# codex pocs

This folder groups Codex SDK proofs of concept in one place, similar to `references/poc/claude`.

## Available POCs

- `hello-world`: the smallest possible Codex SDK example.
- `streaming-tools-poc`: a more advanced example that streams events, surfaces tagged item types, and demonstrates command and file-change activity.

## Notes

- Each POC is its own standalone Node project.
- The local Codex CLI login is reused by these examples.
- Both projects pin `@openai/codex-sdk` to `0.162.1`, the npm `latest` stable
  release checked on 2026-10-11 (UTC). Their lockfiles include the matching CLI.
- Future Codex POCs should be added as sibling folders here instead of separate top-level `references/poc/*` directories.

## Keep `@openai/codex-sdk` current

The SDK ships its own `codex` binary (~270 MB) under
`node_modules/@openai/codex-darwin-arm64/vendor/`; it does **not** use the
`codex` on your `PATH`. Two consequences:

- Exact pins keep both examples on the verified version. To refresh, run
  `npm install @openai/codex-sdk@latest --save-exact` in each PoC, then rerun
  the examples. `^0.x` ranges also do not float across minor versions.
- A stale vendored binary can get blocked by macOS. On 2026-07-27 the
  `0.118.0` binary (Developer ID `OpenAI, L.L.C.`, signed Mar 2026) was
  SIGKILLed by XProtect on exec and moved to Trash, surfacing as
  `Codex Exec exited with signal SIGKILL` plus a `node_modules` tree that
  looked corrupt because the binary kept disappearing. The signature was
  valid — Apple had blocklisted that build. Upgrading to `0.145.0`
  (Developer ID `OpenAI OpCo, LLC`, signed Jul 2026) resolved it.

If you see SIGKILL from `CodexExec`, check whether the vendored binary still
exists after the run before suspecting your code.

The globally installed CLI and the bundled CLI can have different versions
or installation problems. From either PoC, check the bundled CLI with
`./node_modules/.bin/codex --version` and
`./node_modules/.bin/codex login status`.

## Local verification: 2026-10-11 (UTC)

Both installs resolved SDK and CLI version `0.162.1`. The bundled runtime
reported `Logged in using ChatGPT`; the examples passed without an API key.
Both npm installs reported zero vulnerabilities.

| Project | Command | Observed result |
| --- | --- | --- |
| `hello-world` | `npm run hello` | Exact `Hello from Codex.` response |
| `streaming-tools-poc` | `npm run stream:hello` | Exact streamed hello and completed turn |
| `streaming-tools-poc` | `npm run buffered:tools` | Command items, package name, and all five scripts |
| `streaming-tools-poc` | `npm run buffered:tools:raw-reasoning` | Completed inspection; no reasoning item emitted |
| `streaming-tools-poc` | `npm run stream:tools` | Live command events and correct package summary |
| `streaming-tools-poc` | `npm run stream:write` | Wrote exactly `Hello from Codex write demo.` plus newline |

All six commands exited zero. The write used a shell command, so this run
demonstrated `command_execution`, not a separate `file_change` event. Generated
files and traces remain under the ignored `streaming-tools-poc/output/` folder.

The runtime emitted a nonfatal warning that a user-level `sandbox` configuration
key was unrecognized. The demos still completed using their explicit SDK
thread options. The user configuration was not changed. Some agent probes
also looked for `CLAUDE.md` inside the PoC directory and found none; the
requested package inspection and write still completed.
