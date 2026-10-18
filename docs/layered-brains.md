# Layered brains: the mesh of brains (v2.0.0)

One brain used to mean one company. Since v2.0.0 a brain is one **layer**
of someone's world, and brains connect to each other:

```
  person brain --member-of--> org brain --parent-of--> team brain
  (one life)                  (a company)              (a unit of it)
                                  ^
  another person brain --member-of--+
```

- A **person** brain is the working twin of one human's life: commitments,
  family, money, the organizations they belong to.
- An **org** brain is a company (the classic company-of-0).
- A **team** brain is a unit inside an org.
- A **group** brain is any other shared space: a family, a community, a
  project with outside collaborators.

Each brain is still its own private repo with its own constitution, ledger,
approvals, and agents. Nothing about running one brain changed; a brain with
no `brain` block in its config behaves exactly as before.

This page is the contract. The ontology side (typed concepts, schemas, the
Palantir mapping) is in [ontology.md](ontology.md).

## 1. Identity

```json
"brain": { "id": "me", "kind": "person", "name": "A. Person" }
```

`id` is a lowercase slug, unique across the brains it links to. It is the
handle links and markings use. `kind` frames prompts and scaffolds; it never
grants or removes a permission.

## 2. Links (both sides, or nothing)

A link is a typed relationship declared in **both** brains' configs, read as
"<this brain> <relation> <that brain>":

| This brain declares | The other must declare | Meaning |
|---|---|---|
| `member-of` | `has-member` | a person belongs to an org, team, or group |
| `child-of` | `parent-of` | containment: the parent's constitution binds the child |
| `peer-of` | `peer-of` | lateral: partner orgs, two people |

```json
// in the person brain
"links": [
  { "id": "acme", "relation": "member-of", "role": "owner",
    "localPath": "../brain-acme", "repo": "acme-co/brain" }
]
// in the org brain
"links": [
  { "id": "me", "relation": "has-member", "role": "owner",
    "localPath": "../brain-me", "grants": { "brief": true } }
]
```

A link is **live** only when both sides declare it with inverse relations.
One-sided links, mismatched relations, or an identity that does not match
the declared id read nothing, and the reading agent is told why. A brain may
have at most one `child-of` link (one containment chain).

## 3. What crosses a link: grants and markings

Two kinds of marking, the way an ontology's permission model has two:

**`share:` grants (discretionary).** A concept crosses a link only when its
frontmatter names the reader. Deny by default: an unmarked concept never
leaves its brain.

```yaml
share: [members]        # every person brain that is a member of this org
share: [acme]           # exactly the brain with id acme
share: [groups]         # (in a person brain) every org/team/group I belong to
share: [parent]         # my containing brain
share: [children]       # every brain I contain
share: [peers]          # every peer
share: [linked]         # every live link
```

The audience word comes from the **exporter's** declared relation to the
reader. The exporter's config is the only authority on what the reader is.

**`markings:` restrict (mandatory, conjunctive).** A concept marked
`markings: [finance]` crosses only links whose grants clear `finance`, no
matter what its `share:` says. Every marking must be cleared. Use them for
whole categories that must never leak by accident:

```yaml
markings: [finance]          # retirement, bank, tax
markings: [family, health]   # both must be cleared
```

```json
{ "id": "spouse", "relation": "peer-of", "grants": { "markings": ["family"] } }
```

**Link grants.** Beyond concepts, a link can grant the exporter's latest
**brief** (its hub's newest report):

```json
"grants": { "brief": true, "markings": ["finance"] }
```

Grant briefs up the trust gradient, not down it. A brief is derived from
everything its hub read (an inbox, a calendar, marked concepts), so a person
brain that grants its brief to an org exports its owner's whole life in
prose. `validate` warns when a person brain does this.

## 4. Reading linked brains (the `brains` source)

An agent opts in like any source:

```yaml
context-sources: [brains]
```

Every run, for each link, the harness opens the linked brain **read-only**
(a facade whose write methods throw), asks it what it shares with this
brain, verifies the relationship from both sides, and inlines:

- the inherited constitution, for a `child-of` link;
- the latest brief, when granted;
- every shared concept, cited as `brain://<id>/<path>`.

It also states what it could not see: "3 of 140 concepts". Budgets are fixed
(6K chars per concept, 30K per brain) and anything over is named, not
silently dropped. A `read-request` can ask for one shared concept by path
(`brains: [acme/ops/calendar.md]`); "not shared" and "does not exist" get the
same answer, so a read-request is never an existence oracle.

### Transports

| Transport | Where | How |
|---|---|---|
| `localPath` | laptop tier | sibling checkout, resolved against this instance's root; tokenless |
| `repo` | laptop and cloud | GitHub tarball read with the link's own token |

The repo transport reads the token from `BRAIN_LINK_<ID>_TOKEN` (or the
link's `tokenEnv`). It **never** falls back to the brain's own
`GITHUB_TOKEN`: give each link a fine-grained token with Contents read-only
on exactly that repo, or the link is not read in the cloud. On Workers, any
`BRAIN_LINK_*_TOKEN` secret is passed through to the engine.

### Cross-brain references

Concepts can point into a linked brain with `brain://<id>/<path>`. The
conformance pass skips these (it cannot see other repos);
`anima-mesh brains` resolves them and warns when a target is not shared
with this brain.

## 5. Containment inherits law

A `child-of` link makes the parent's constitution binding on the child:

```bash
anima-mesh brains sync --instance <child-brain>
```

writes `bundle/inherited/<parent-id>/constitution.md` (type
`inherited-constitution`, immutable, with the source hash), flattening the
whole ancestor chain. The gatekeeper unions every inherited
`gated-actions` list with the child's own: a child can add gates, never
remove one. **Law is materialized** (offline, versioned, auditable in git);
**context is live** (briefs and shared concepts are read every run).
`anima-mesh brains` reports an inherited copy that has gone stale.

Membership inherits nothing. A person brain is sovereign: an org cannot
impose its constitution on a member's life. The member acting inside the
org is bound by the org brain's own gates.

## 6. Multi-player: members and roles

```json
"identity": {
  "principal": { "name": "Ada Lovelace", "email": "ada@example.com" },
  "members": [
    { "id": "ada", "name": "Ada Lovelace", "email": "ada@example.com", "role": "owner", "brain": "ada" },
    { "id": "bo",  "name": "Bo",           "role": "approver" },
    { "id": "cy",  "name": "Cy",           "role": "viewer" }
  ]
}
```

| Role | May |
|---|---|
| `owner` | amend the constitution, decide any approval |
| `approver` | decide approvals |
| `contributor` | direct the mesh |
| `viewer` | read briefs and the dashboard |

With members declared, `anima-mesh gate approve|deny --by <id|email>` is
checked in code: only an owner or approver member may decide, and the record
stores the member id (without `--by`, the principal's own member record
decides). Without a `members` block a brain is single-player: the principal
alone, as owner, exactly as before.

What is enforced today is the approval decision. Direction senders and
dashboard logins still come from the Workers' own allowlists
(`DISCORD_DM_USER_ID`, `SLACK_ALLOWED_USER_IDS`, `DIRECTION_GMAIL_ALLOWED_FROM`,
`WEB_ALLOWED_EMAILS`); deriving those from member roles is on the roadmap
below.

**Multi-player in a chat room (v2.3).** A team or org brain can live in a
Slack channel: the brief posts there, and anyone the channel gate admits can
@-mention the persona and get an answer in thread, with the conversation as
context. `SLACK_ALLOWED_USER_IDS=*` with one pinned channel makes Slack's
channel membership the allowlist. Layering composes with it. A person brain
and its org brain can each have their own app in the same workspace, each in
its own channel, and each answers from its own brain, reading across the
link only what the other brain's `share:` grants allow. See
[slack.md](slack.md).

**The brain is the unit of access control.** A git repo cannot hide one file
from someone who can clone it, so per-person visibility inside one brain is
not a promise this engine makes. Collaboration is modeled the other way
round: each person keeps their own person brain, shared work lives in an org,
team, or group brain they are members of, and markings decide what crosses.

## 7. The principal's own Google account (`gmail`, `google-calendar`, `google-drive`)

A person brain's hub usually reads its principal's inbox, calendar, and
recent Drive files:

```yaml
context-sources: [brains, gmail, google-calendar, google-drive]
```

These are **not** the persona's mailbox (the `gmail` channel, `GMAIL_*`,
which sends briefs and receives directions). They are the human's own
account, read-only by scope: consent asks for `gmail.readonly`,
`calendar.readonly`, and `drive.readonly` on one OAuth client, and a token
with any wider scope is refused. All three sources share one refresh token.

```bash
# once, on the laptop: an OAuth client of type "Desktop app" in a project
# whose consent screen is In Production, with the Gmail, Calendar, and Drive
# APIs enabled (an unverified app used by its owner needs no Data Access
# entries); its id/secret go in .env.local as
# GOOGLE_READ_CLIENT_ID / GOOGLE_READ_CLIENT_SECRET
anima-mesh connect google --instance <brain>
```

The command runs a loopback PKCE consent, writes `GOOGLE_READ_REFRESH_TOKEN`
into `.env.local` (mode 600, never printed), and verifies the account. For
the cloud tier, load the three `GOOGLE_READ_*` values as Worker secrets.
When the engine adds a scope (as it did with `drive.readonly`), re-run the
command: the new refresh token replaces the old one, and the cloud secret
must be updated too. Until then a Drive section names the scope gap and the
fix instead of failing silently.

Two safety properties live in code:

- **Redaction.** Everything inlined passes `redactSensitive`: card and
  account-length digit runs, SSN shapes, one-time codes, and
  `password: ...` values are replaced before any prompt sees them, and so
  before any report is committed.
- **Untrusted framing.** Inbox and calendar text is labeled third-party
  data. Instructions inside an email are never direction; directions arrive
  only through the allowlisted channel edge.

A person brain's natural document store is that same account's Drive: the
brain keeps the facts (dates, amounts, obligations) and links the file;
the document of record stays in Drive. See "Pair the brain with a document
store" in [starting-a-company.md](starting-a-company.md).

Defaults are least exposure: inbox snippets (not bodies) for the last two
days without promotions/social/forums, and calendar titles and places for
14 days ahead, with descriptions and attendee identities off, and Drive
file NAMES (no contents) modified in the last 14 days. Knobs:
`GMAIL_READ_QUERY`, `GMAIL_READ_MAX`, `GMAIL_READ_BODIES`,
`GCAL_READ_CALENDARS`, `GCAL_READ_DAYS_AHEAD`, `GCAL_READ_DAYS_BACK`,
`GCAL_READ_DESCRIPTIONS`, `GDRIVE_READ_DAYS`, `GDRIVE_READ_MAX`,
`GDRIVE_READ_QUERY` (a Drive `q` clause, e.g. one folder). A `read-request`
can open one message in full (`gmail: [<message-id>]`) or one Drive file
(`google-drive: [<file-id>]`: Docs and Slides as text, Sheets as CSV, text
files, PDFs extracted), redacted.

## 8. The operator's view

```bash
anima-mesh brains   --instance <brain>   # identity, members, links, WHO CAN SEE WHAT
anima-mesh validate <brain>              # + link map, markings, share tokens
anima-mesh ontology --instance <brain>   # types, schemas, link types, brain:// refs
```

`brains` computes both directions with the same function the harness
enforces with: what each linked brain shares with this one, and what this
brain would share with it. Read it before you mark anything sensitive.

## 9. Trust model, honestly

- **Same-owner links** (one person's brains on one laptop, or repos under
  one account) are protected by code: the exporter's markings decide what
  is inlined, linked brains are read-only, and nothing unmarked crosses.
  The reader still holds a credential that could read the whole linked repo
  (a sibling checkout, or a repo token), so this is least exposure, not a
  cryptographic boundary.
- **Cross-owner links** (two different people's brains) need the boundary
  on the exporter's side. Planned: an export endpoint on the exporter's
  Worker, authenticated per link, serving only the computed export view, so
  the reader never holds a credential to the exporter's repo. Until then,
  link across owners only through a shared group brain both are members of.
- **Tool-using laptop harnesses** (`claude-code`) can open any file the
  laptop can. Markings bind what the engine inlines, not what a subprocess
  with filesystem access might read. Keep those harnesses for high-trust
  agents, as the trust tiers already require.
- **Credentials are the boundary that matters most.** A brain-wide token
  with access to every repo under an account (a classic PAT with `repo`
  scope) can read every linked brain in full. Prefer fine-grained, per-repo
  tokens everywhere, and give each link its own.

## 10. Roadmap

- **Export endpoint** for cross-owner links (above).
- **Marking propagation**: a report written after reading marked input
  carries those markings, so it cannot be granted onward by accident.
- **Typed action types** as concepts (parameters, submission criteria,
  per-action autonomy), generalizing today's `schedule-request`,
  `draft-request`, `defect-report`, and `read-request` blocks.
- **Per-member delivery and directions**: briefs addressed to each member,
  direction allowlists derived from member roles.
- **One Worker, many brains**: today each brain deploys its own Workers.
