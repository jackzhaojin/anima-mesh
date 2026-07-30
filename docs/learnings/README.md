# Learnings — hard-won platform knowledge

Operational lessons the engine's code now encodes, written down so the next
session (human or AI) doesn't re-derive them from a production failure. These
are **engine-general**: vendor gateway behavior, platform quirks, protocol
traps. Anything about a particular company, persona, or deployment belongs in
that instance's own repo, not here (see
[docs/engine-vs-instance.md](../engine-vs-instance.md)).

## Conventions (write for an AI reader)

- One learning per file, named `YYYY-MM-DD-<slug>.md` — the date it was
  learned, not written.
- **Symptom first**: open with the observable failure, verbatim where possible
  (status codes, error bodies, header presence/absence). A future session
  greps for what it *sees*.
- **State the rule in one bold sentence** near the top; the narrative and
  evidence follow for readers who need to trust it.
- Include the **bisect table** or probe evidence — a learning without its
  evidence is a rumor.
- End with **where the engine encodes it** (file + test), so drift is
  detectable, and external references if any.
- Learnings are immutable history: if a rule changes, write a new dated
  learning that supersedes the old one and cross-link both.

## Index

| Date | Learning |
|---|---|
| 2026-07-11 | [Some vendor edges WAF-block Cloudflare Workers egress](2026-07-11-workers-egress-waf.md) |
| 2026-07-12 | [Anthropic OAuth gateway: identity must be its own system block](2026-07-12-anthropic-oauth-gateway.md) |
| 2026-07-12 | [A Google OAuth app in "Testing" kills its refresh tokens every 7 days](2026-07-12-google-oauth-testing-expiry.md) |
| 2026-07-18 | [Adaptive thinking spends your max_tokens — small budgets yield zero text](2026-07-18-adaptive-thinking-output-budget.md) |
| 2026-07-18 | [GitHub 403s UA-less calls — Workers' fetch sends no User-Agent](2026-07-18-github-ua-less-403.md) |
| 2026-07-22 | [An acknowledged-but-unapplied order is the worst state](2026-07-22-acknowledged-but-unapplied.md) |
| 2026-07-22 | [Every mutable surface a beat writes must ride the beat's own commit](2026-07-22-beat-writes-own-commit.md) |
