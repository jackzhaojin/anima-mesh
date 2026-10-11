# Refreshing a shared Codex login breaks the other Codex surfaces using it

**Symptom:** right after a program refreshed the ChatGPT login stored in
`~/.codex/auth.json` (a valid `refresh_token` grant, new tokens written back
atomically), `codex login status` briefly reported `Not logged in` and
`auth.json` disappeared. A few minutes later a new login appeared, with a
`last_refresh` that came from neither the program nor the operator's CLI.

**The rule: never refresh a Codex login the engine shares. Borrow the access
token read-only and let Codex refresh its own login.**

## Mechanism

ChatGPT refresh tokens rotate: a refresh returns a new refresh token and
spends the old one (confirmed live: both access and refresh token changed on
one grant). The ChatGPT desktop app's built-in Codex shares `~/.codex` but
keeps its tokens in memory. The most likely sequence (the evidence below
fits it; Codex's logs did not name the step): after the outside refresh the
app still held the spent refresh token, its next refresh failed, and its
recovery tore the login down and re-minted it. Writing the rotated tokens back to
`auth.json` is correct for processes that re-read the file, but cannot reach
a process that cached them.

A borrower never needs to refresh anyway: the access token lasts about
10 days (`exp` minus now read 239.9 h right after a refresh), and Codex
refreshes it whenever it is used.

## Evidence (2026-10-11)

1. Forced one refresh through the engine's then file-backed source:
   access rotated, refresh rotated, `auth_mode` and other keys preserved,
   mode `600`. `codex login status` and a `codex exec` still worked.
2. Minutes later, a provider run failed: `no Codex login at ~/.codex/auth.json`;
   the file was absent and `codex login status` said `Not logged in`.
3. Shortly after, `auth.json` was back with a new `last_refresh` and a
   refresh token different from both earlier ones. Running at the time:
   the ChatGPT desktop app's Codex service and renderers.

## Where the engine encodes it

- `src/providers/codex-auth-file.ts` — `fileCodexAuth` reads `auth.json` per
  call, never writes it, never sends a refresh grant; an expired or rejected
  token fails with "open Codex once so it refreshes its own login".
- `test/providers-codex.test.ts` — "hands out the CLI's access token and
  account, and never writes the shared file" asserts no fetch and an
  unchanged file.
