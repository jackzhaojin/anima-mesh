---
type: runbook
title: "Engine feedback - core issue-filing path"
date: {{DATE}}
{{GENERATED}}
sources:
  - { id: engine-config, resource: "../../animamesh.config.json", title: Configured engine issue target }
---

# Engine feedback

Reporting engine bugs and missing capabilities is a core brain capability,
for personal and organizational brains alike. Use general requirements,
reproduction steps, expected versus actual behavior, and synthetic examples.
Principal-requested engine enhancements use the same feedback path. Private
brain content never belongs in the public engine's issue tracker.

## Enable the narrow filing path

The operator checks all three requirements in the runtime that will file:

1. Record the principal's authorization for public, de-identified engine
   issues in a dated decision and the bundle log. Promote the hub to L3
   and add `defect-report` to its `whitelist`. That action alone is enough;
   it does not require `schedule-update`, `draft-write`, or general
   publishing permission. New hubs start at L1 until the principal grants
   the promotion. Existing constitution gates still apply.
2. Check `animamesh.config.json` -> `engine.repo`: this is the target
   engine repository, not the private brain repository.
3. Provision `GITHUB_DEFECTS_TOKEN` with Issues read/write on that engine
   repository. Store it in the ignored local environment and as a secret
   on the heartbeat/direction Worker where needed. Include the key in the
   instance's secret uploader, local Worker environment generator, and CI
   secret wiring where those exist. A local key does not configure a
   deployed Worker. The automatic filing path never falls back to
   `GITHUB_TOKEN` or the brain's GitHub App credential. Never expose the
   token to a prompt, report, or issue.

Regenerate local agent artifacts with `anima-mesh export-local` after
changing the hub concept. The principal or operator provisions credentials;
the agent does not create credentials or grant itself permissions.

## What the hub does

Review the complete report for privacy before emitting it: no private
names, emails, concepts, conversations, documents, file names, paths, IDs,
links, screenshots, or credentials. A clean report describes engine
mechanics independently of the brain that encountered them.

Once authorized, end a heartbeat or direction response with this format:

```defect-report
title: <one line, engine-generic>
---
<reproduction or general requirement; expected versus actual behavior;
synthetic example; engine version if known>
```

The harness performs the action; the model needs neither a GitHub tool nor
access to the credential. It enforces the ladder and whitelist, checks
configured principal/persona names and emails, deduplicates open defect
titles, caps reports at two per run, and appends the outcome to the ledger.
The identity check is an additional guard, not proof that arbitrary
private content has been removed. General publishing remains gated.

## Read the outcome honestly

| Evidence | Meaning and next step |
|---|---|
| `defect-report-denied` | Level, whitelist, or another gate blocked the request. Report the missing grant; no fallback draft is written for a gate denial. |
| `defect-filed`, with an issue URL | The harness created an issue or found an existing open issue with that title. Use that URL as evidence. |
| `defect-drafted`, with a private path | Filing was unavailable: missing token/target, an identity hit, or an API failure. Surface the fallback path and any recorded reason; do not claim an issue was opened. |

Fallback drafts live under the configured drafts directory's `defects/`
subdirectory. The operator can inspect them with `anima-mesh defect list`
and deliberately promote cleaned reports with `anima-mesh defect file`.
Do not infer failure from a lack of direct GitHub tools, or success from
the model merely saying it filed something. Read the run report and ledger.
