# The CRM domain shelf — relationships as OKF concepts

*Promoted from a live instance (de-identified). The pattern: when a
company-of-0 outgrows back office, its first front-office need is
remembering people — and the bundle is already a database with a
validator. This page is the generic spec; an instance copies it into
`bundle/crm/taxonomy.md` and adapts the vocabulary.*

## Why not a SaaS CRM

A hosted CRM gives a company-of-0 three problems it doesn't need: an
integration surface (MCP servers, OAuth, API quotas) between its agents
and its own data; a per-seat pricing model for a company with no seats;
and deletion risk — a dormant free-tier account can be purged with its
data. A CRM made of concepts has none: agents read it natively in every
prompt-assembly pass, git is the audit trail and backup, and the same
conformance check that guards the constitution guards the contact list.
The trade-off is scale — file-per-record is right for hundreds of
relationships, not tens of thousands. A company-of-0 is on the correct
side of that line for a long time.

## The four types

```
bundle/crm/
  taxonomy.md                    the instance's schema + operating rules
  orgs/<slug>.md                 crm-org          — companies, communities
  people/<first-last>.md         crm-person       — human relationships
  engagements/<yyyy-slug>.md     crm-engagement   — pursuits (deals)
  interactions/<date-who-ch>.md  crm-interaction  — one touch, append-only
```

Records cross-reference with **standard relative markdown links** so the
conformance pass verifies the relationship graph. Wikilinks are invisible
to the checker — don't use them.

Suggested frontmatter (adapt freely; the validator only requires `type`):

- **crm-person** — `name`, `org`, `roles` (prospect | champion | referrer
  | partner | investor | talent | peer | community | press), `stage`,
  `source` (how the relationship started — referral provenance lives
  here), `last-touch`, `channels`, and any compliance fields (below).
- **crm-org** — `name`, `category` (prime | staffing | partner |
  client-target | investor | community | vendor), `stage`, `last-touch`,
  compliance fields.
- **crm-engagement** — `with`, `shape` (what kind of deal), `stage`,
  `owner`, `next-action`, `date`.
- **crm-interaction** — `date`, `who`, `channel`, `direction`. Body: what
  happened, what was promised. **Append-only** — corrections are new
  interactions; after each one, update `last-touch` on the records it
  touched. File-per-touch also keeps the two writers (operator sessions
  and cloud runs) from ever merge-conflicting.

## Relationship-first stages, not funnel stages

Marketing-funnel vocabularies (MQL/SQL) assume volume; a company-of-0
runs on relationship strength:

- person: `met → connected → warm → trusted` — dormancy is **computed**
  from `last-touch` (e.g. >90 days), never a stage someone must remember
  to set
- org: `identified → researched → in-conversation → engaged → client → parked`
- engagement: one ladder shared with the instance's pipeline view, e.g.
  `identified → researched → drafted → sent → in-conversation →
  negotiating → won | parked | dead`

Keep one vocabulary across CRM and pipeline — agents reason over stages;
synonyms rot.

## Compliance screens live in the data

The pattern's differentiator: encode the instance's legal boundaries as
frontmatter so agents enforce them as **data rules**, not remembered
policy. Examples an instance might define in its taxonomy:

- `screen:` on orgs — is this organization off-limits (a restricted
  client, a conflicted partner) and per which fact concept?
- `boundary:` on people — may this person only be contacted inbound?
- `confidential:` on any record — is the relationship itself under NDA,
  and therefore never nameable in drafts or external output?

Each screen should cite the governing concept (a fact, a decision) so the
rule is auditable. Agents at any level check screens before proposing
outreach; the taxonomy's rules section is binding agent instruction.

## Views are grep, not software

The system of record is the folder; working views are cheap files or
one-liners the hub maintains by hand:

```bash
grep -rl "stage: in-conversation" bundle/crm/engagements/
grep -l  "stage: warm"            bundle/crm/people/     # then check last-touch
```

A pipeline view file (a table of non-terminal engagements, each row
linking to its record) is the daily screen; regenerating it is hub work,
not tooling.

## Who writes

The autonomy ladder governs the CRM exactly like everything else: the
principal edits records directly; an L1 hub **proposes** new records,
stage moves, and hygiene fixes in its report (stale warm relationships,
engagements with an empty `next-action`, screen violations); L2 makes
those proposals as drafts; L3 can be whitelisted to apply reversible
record edits itself. Interactions stay append-only at every level.

## Adopting it

1. Copy this page's shape into `bundle/crm/taxonomy.md`; adapt roles,
   categories, shapes, and screens to the instance.
2. Seed only real, established relationships — an honest small CRM beats
   an aspirational large one.
3. Add CRM stewardship to the hub agent's duties.
4. `pnpm cli validate` — the same PASS that guards the rest of the brain
   now guards the CRM.
