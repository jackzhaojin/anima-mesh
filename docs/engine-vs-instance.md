# Engine vs. instance — where knowledge lives

AnimaMesh is two repos with a one-way dependency. **The engine** (this repo,
public) is everything generic: harness, providers, workers, templates, CLI,
platform learnings. **An instance** (a private "brain" repo) is everything
about one real organization: its facts, decisions, personas, secrets
references, config, and deploy workspaces. The instance pins the engine by
git tag (`animamesh.config.json → engine.ref`); the engine never knows any
instance exists.

This file is the sorting rule. When you're about to write something down and
aren't sure where it goes, run the checklist. For the visual layout of what
each repo contains, see the diagram in
[starting-a-company.md](starting-a-company.md).

## The checklist

Ask in order — first "yes" decides:

1. **Does it name a company, person, persona, or their accounts?** → instance.
   No exceptions; not in code comments, not in test fixtures, not in docs.
2. **Is it a secret, a credential reference, or a deploy coordinate** (Worker
   names, hostnames, account ids, OAuth client ids)? → instance. The engine
   ships `wrangler.jsonc` *templates*; the filled-in config is an instance
   act.
3. **Is it a decision about how one organization operates** (which channels,
   which caps, which agents run where)? → instance, as a dated decision
   concept. The engine ships the *capability*; the instance decides its use.
4. **Would it be true for any other company running this engine?** → engine.
   Vendor gateway behavior, platform quirks, protocol requirements, test
   patterns → [docs/learnings/](learnings/). Architecture and module
   contracts → the READMEs. Enforcement rules → code + tests.
5. **Is it a capability built inside an instance for expedience?** → flag it
   **"generalize me"** in the instance, then promote: rewrite de-identified
   in the engine (placeholders for identity, config for choices), add tests,
   release a tag, and have the instance re-pin and delete its local copy.
   Promotion is a deliberate act with a paper trail on both sides.

## Litmus tests that have already come up

| Knowledge | Where it went | Why |
|---|---|---|
| "The Anthropic OAuth gateway requires the identity sentence as its own system block" | engine ([learning](learnings/2026-07-12-anthropic-oauth-gateway.md) + provider code + tests) | true for every subscription-token user |
| "A vendor edge WAF-blocks Workers egress; probe before building" | engine ([learning](learnings/2026-07-11-workers-egress-waf.md) + HTML-block detection in providers) | platform behavior, org-independent |
| "*Our* mesh redirects kimi cognition to Claude as of <date>" | instance (decision concept + `cognition.overrides` in its config) | one org's routing choice |
| Worker hostnames, daily direction caps, allowlisted sender ids | instance (its `wrangler.jsonc` vars + config) | deploy coordinates |
| Agent roster archetypes (bookkeeper, chief-of-staff, …) | engine (`templates/agents/` with `{{PLACEHOLDER}}` identity) | roles are generic; identity is config |
| Which human approves what, boundary maps, activation gates' *state* | instance | legal/organizational reality |

## Why the boundary is strict

- **The engine is public.** One leaked name or key is unrecoverable history.
  Scan every diff for instance names, real emails, and secrets before commit.
- **Reusability is the product.** Every instance-specific literal that sneaks
  in makes the next instance's scaffold dirtier.
- **The instance stays portable too**: because all logic lives engine-side,
  an instance survives engine upgrades as config-and-content only — and the
  engine's docs can be read by any AI session without access to anyone's
  private data.
