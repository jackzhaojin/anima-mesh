# codex pocs

This folder groups Codex SDK proofs of concept in one place, similar to `references/poc/claude`.

## Available POCs

- `hello-world`: the smallest possible Codex SDK example.
- `streaming-tools-poc`: a more advanced example that streams events, surfaces tagged item types, and demonstrates command and file-change activity.

## Notes

- Each POC is its own standalone Node project.
- The local Codex CLI login is reused by these examples.
- Future Codex POCs should be added as sibling folders here instead of separate top-level `references/poc/*` directories.
