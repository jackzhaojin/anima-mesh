# A Google OAuth app in "Testing" kills its refresh tokens every 7 days

**Symptom**: Gmail integration (inbound direction polling, email delivery)
works perfectly after consent, then dies about a week later with

```
400 invalid_grant
```

on the token refresh. Re-consenting fixes it — for another week.

**The rule: a Google Cloud OAuth consent screen with publishing status
"Testing" expires every refresh token after 7 days, by design. Publish the
app to "In Production" before relying on any long-lived Gmail credential.**

Google documents the 7-day expiry for testing-status apps
([OAuth 2.0 docs: refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)),
but nothing at consent time warns that the token being minted is a
time bomb — consent succeeds, the integration passes every check, and the
failure arrives days later, disconnected from any change. It reads like a
revoked credential or a vendor incident, not a publishing-status default.

## Evidence (2026-07-12, live instance)

- Gmail directions wired and proven on a consent screen still in "Testing";
  the weekly-death trap identified the same day and tracked as a standing
  reminder.
- Publishing the consent screen to "In Production" (no verification review
  was required for the scopes involved) ended the expiry; the same refresh
  token has run since without re-consent.

Scope note: for an app whose only users are its own operators (each instance
runs its own OAuth client), "In Production" does not trigger Google's
verification gauntlet for non-sensitive configurations — and even where a
verification banner appears, the token expiry stops regardless.

## Where the engine encodes it

This one is procedure, not code — the engine consumes
`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` and cannot
see the consent screen's publishing status. The runbook carries the warning:

- `docs/deploying-cloud.md` — the Gmail secrets row states the rule at the
  moment an operator wires the credential.

If a working Gmail surface starts failing with `invalid_grant` roughly
weekly, check the consent screen's publishing status before rotating
anything.
