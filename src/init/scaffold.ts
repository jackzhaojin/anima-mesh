import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { loadBundle } from "../okf/bundle.js";
import { checkConformance, type ConformanceReport } from "../okf/conformance.js";
import { addLogEntry } from "../okf/log.js";
import { OKF_VERSION } from "../okf/trust.js";
import { CONFIG_FILENAME, type InstanceConfig } from "../instance/config.js";
import type { BrainKind } from "../instance/config-core.js";
import { BRAIN_KINDS, isSlug, RESERVED_TOKENS } from "../brains/core.js";
import { fillTemplate, loadAgentTemplate, templatesDir } from "./templates.js";
import { agentsFromBundle } from "../agents/concept.js";
import { composeLocalAgents, selectLocalAgents } from "../local/agents-core.js";

/**
 * The init's contract (and its acceptance test): run against an empty
 * directory, produce a brain repo that passes the same animamesh conformance
 * the reference instance passes. The engine is tested by the act that
 * demos it.
 */
export interface InitAnswers {
  orgName: string;
  principalName: string;
  principalEmail?: string;
  /** The agent persona, if the instance names its mesh (identity-plural by design). */
  personaName?: string;
  personaEmails?: string[];
  description?: string;
  timezone?: string;
  /** Agent template names to instantiate. */
  agents: string[];
  defaultModel?: string;
  defaultHarness?: string;
  engineRepo?: string;
  engineRef?: string;
  /**
   * What the brain models (v2.0.0). Absent ⇒ an org, and no `brain`
   * identity block is written unless `brainId` is given - exactly the
   * pre-layering scaffold.
   */
  brainKind?: BrainKind;
  /** The brain's id for links and `share:` markings. Default: slug of orgName. */
  brainId?: string;
  /**
   * Local mode (v2.3.6): nothing leaves the machine except the model call -
   * console delivery, no network sources or web search, no public engine
   * issues, no cloud tier (instance/local-mode.ts).
   */
  localOnly?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: string;
}

export interface ScaffoldResult {
  root: string;
  created: string[];
  conformance: ConformanceReport;
}

const DEFAULT_AGENTS = ["compliance-ops"];
/** A person brain starts with its hub and its obligations keeper (person variants). */
const DEFAULT_PERSON_AGENTS = ["chief-of-staff", "compliance-ops"];

function localDay(now: Date): string {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}

function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** Instances pin the engine by tag; default the pin to the version this scaffolder shipped in. */
function engineVersionTag(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? `v${pkg.version}` : "main";
  } catch {
    return "main";
  }
}

export async function scaffoldBrain(targetDir: string, answers: InitAnswers): Promise<ScaffoldResult> {
  const root = path.resolve(targetDir);
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`target directory ${root} is not empty — init only scaffolds from nothing`);
  }
  // The scaffolding human's calendar day, not UTC's: an evening init in a
  // western timezone must not date its first event "tomorrow". An injected
  // clock (tests) is taken literally.
  const date = answers.now ? answers.now.slice(0, 10) : localDay(new Date());
  // OKF v0.2 provenance (SPEC §5.2, §7): every concept init writes says who
  // wrote it and when. Nothing is `verified` - init confirms nothing.
  const generated = `generated: { by: anima-mesh/${engineVersionTag()}, at: ${new Date(answers.now ?? Date.now()).toISOString()} }`;
  const kind: BrainKind = answers.brainKind ?? "org";
  if (!BRAIN_KINDS.includes(kind)) throw new Error(`init: brain kind must be one of ${BRAIN_KINDS.join("|")}`);
  const isPerson = kind === "person";
  // An identity block is written when the caller asks for layering at all.
  const brainId = answers.brainKind || answers.brainId ? (answers.brainId ?? slugOf(answers.orgName)) : undefined;
  if (brainId !== undefined && (!isSlug(brainId) || RESERVED_TOKENS.has(brainId))) {
    throw new Error(`init: brain id '${brainId}' must be a lowercase slug and not a reserved word`);
  }
  const agents = answers.agents.length > 0 ? answers.agents : isPerson ? DEFAULT_PERSON_AGENTS : DEFAULT_AGENTS;
  // Knowledge defaults to area / year-or-topic / concept; runtime control surfaces retain
  // their established paths. Existing flat bundles remain fully supported.
  const knowledgeArea = isPerson ? "personal" : "organization";
  const factsRel = `${knowledgeArea}/identity/${isPerson ? "person" : "organization"}.md`;
  // Dated records file under their calendar year (docs/memory-layout.md).
  const year = date.slice(0, 4);
  const eventRel = `events/${year}/${date.replaceAll("-", "")}-instance-created.md`;
  const local = answers.localOnly === true;
  // A local brain defaults to a local CLI harness; the model call is its one
  // network path, and the organization picks which one is approved.
  const model = answers.defaultModel ?? (local ? "claude-sonnet-5-5" : "kimi-code/kimi-for-coding");
  const harness = answers.defaultHarness ?? (local ? "claude-code" : "opencode");
  const persona = answers.personaName?.trim() || undefined;

  const created: string[] = [];
  const put = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    created.push(rel);
  };

  // ── instance config: the pairing between this brain and the engine ──────
  const config: InstanceConfig = {
    ...(local ? { mode: "local" as const, delivery: { channels: ["console"] } } : {}),
    bundle: "bundle",
    ledger: "ledger/actions.jsonl",
    approvals: "approvals",
    reports: "reports",
    drafts: "drafts",
    engine: { repo: answers.engineRepo ?? "github.com/jackzhaojin/anima-mesh", ref: answers.engineRef ?? engineVersionTag() },
    identity: {
      principal: { name: answers.principalName, ...(answers.principalEmail ? { email: answers.principalEmail } : {}) },
      ...(persona
        ? { persona: { name: persona, ...(answers.personaEmails?.length ? { emails: answers.personaEmails } : {}) } }
        : {}),
    },
    ...(brainId ? { brain: { id: brainId, kind, name: answers.orgName }, links: [] } : {}),
    // A person's brain runs no commercial agents - the D11 dual gate is an org concern.
    ...(isPerson ? {} : { activation: { boundaryMapVerified: false, optionTrigger: null, founderWaiver: false } }),
  };
  put(CONFIG_FILENAME, JSON.stringify(config, null, 2) + "\n");

  put(
    ".gitignore",
    ["# secrets never enter the brain repo", ".env", ".env.*", "local-only/", "", "node_modules/", ".DS_Store", ""].join("\n"),
  );

  put(
    "README.md",
    `# ${answers.orgName} — brain\n\n` +
      `Private AnimaMesh instance: an OKF knowledge bundle plus the operational\n` +
      `surfaces (ledger, approvals, reports) for ${isPerson ? "one person's life (a personal brain)" : "a company-of-0 mesh"}.\n\n` +
      (brainId ? `- Brain: \`${brainId}\` (${kind}) - links to other brains live in animamesh.config.json\n` : "") +
      `- Engine: ${config.engine!.repo} @ ${config.engine!.ref}\n` +
      `- Principal: ${answers.principalName} (the approval gate)\n` +
      (persona ? `- Mesh persona: ${persona}\n` : "") +
      `\nOperate from an engine checkout (github.com/jackzhaojin/anima-mesh) until\n` +
      `the npm package ships:\n\n` +
      `    pnpm cli validate <path-to-this-repo>\n` +
      `    pnpm cli run <agent> --instance <path-to-this-repo>\n\n` +
      `Core engine feedback: [bundle/ops/engine-feedback.md](bundle/ops/engine-feedback.md)\n` +
      `explains the hub's narrow issue-filing grant and runtime credential setup.\n\n` +
      `## Memory layout\n\n` +
      `Start at [bundle/index.md](bundle/index.md). Memory is two tiers deep by\n` +
      `default, three at most: an area, then a calendar year (dated records such\n` +
      `as events/${year}/) or a topic, then optionally one more level. Each\n` +
      `populated directory has an index linking its immediate children with short\n` +
      `descriptions; the root is an area map rather than an exhaustive file list.\n` +
      `Use stable names for evergreen facts and YYYYMMDD-slug.md for dated\n` +
      `records, preserving ISO YYYY-MM-DD dates in metadata and logs. Runtime\n` +
      `anchors (constitution, agents, ops and the root log) keep their paths.\n`,
  );

  // ── the bundle ───────────────────────────────────────────────────────────
  const agentLinks = agents.map((a) => `- [${a}](${a}.md) - ${a} (L1).\n`).join("");
  put(
    "bundle/index.md",
    `---\nokf_version: "${OKF_VERSION}"\n---\n\n` +
      `# ${answers.orgName} — bundle index\n\n` +
      `Single source of truth for the ${answers.orgName} mesh, an OKF v${OKF_VERSION} bundle. One concept per\n` +
      `file; \`type\` required; this index and [log.md](log.md) (newest first) are reserved.\n\n` +
      `Memory is an area, then a calendar year (dated records) or a topic, then at\n` +
      `most one more level. Follow local indexes for details; runtime control\n` +
      `paths stay stable.\n\n` +
      `| Area | What it holds |\n|---|---|\n` +
      `| [constitution.md](constitution.md) | Immutable hard limits — agents may not modify |\n` +
      `| [${knowledgeArea}](${knowledgeArea}/index.md) | Identity facts and document memory |\n` +
      `| [Operations](ops/index.md) | Calendar, watch-list, schedule and engine feedback |\n` +
      `| [Events](events/index.md) | Dated, append-only history |\n` +
      `| [Agents](agents/index.md) | Roles and approved capabilities |\n`,
  );

  put(`bundle/${knowledgeArea}/index.md`,
    `# ${isPerson ? "Personal" : "Organization"} memory\n\n` +
    `- [Identity](identity/index.md) - Stable identity facts.\n` +
    `- [Documents](documents/index.md) - Source-document knowledge and pointers.\n`);
  put(`bundle/${knowledgeArea}/identity/index.md`,
    `# Identity\n\n- [${isPerson ? "Person" : "Organization"}](${isPerson ? "person" : "organization"}.md) - Stable identity; verify against sources.\n`);
  put(`bundle/${knowledgeArea}/documents/index.md`,
    "# Document memory\n\nNo documents cataloged yet. Add concise concepts here and link originals\n" +
    "in the principal's document store; update this index when adding a concept.\n");
  put("bundle/ops/index.md",
    "# Operations\n\n" +
    "- [Focus](focus.md) - What matters right now; every agent reads it first, and it shapes the brief.\n" +
    `- [Calendar](calendar.md) - ${isPerson ? "Personal obligations" : "Compliance deadlines"}.\n` +
    "- [Watch-list](watch-list.md) - Signals worth researching.\n" +
    "- [Schedule](schedule.md) - Cadence overrides and one-shot wakes.\n" +
    "- [Engine feedback](engine-feedback.md) - Authorization and setup for narrow issue filing.\n");
  put("bundle/agents/index.md", "# Agent roster\n\n" + agentLinks);
  put("bundle/events/index.md", `# Events\n\nOne folder per calendar year, newest first.\n\n- [${year}](${year}/index.md) - Events dated ${year}.\n`);
  put(`bundle/events/${year}/index.md`, `# Events ${year}\n\n- [Instance created](${path.posix.basename(eventRel)}) - Brain scaffolded on ${date}.\n`);

  put(
    "bundle/log.md",
    addLogEntry(
      "# Bundle log\n\nWhat changed in this bundle, grouped by date, newest first (OKF v0.2 §9).\n",
      date,
      `- **Creation**: Brain scaffolded by \`anima-mesh init\` (engine ${config.engine!.ref}). ` +
        `Agents: ${agents.join(", ")}. Every fact starts unverified until confirmed against source documents.`,
    ),
  );

  put(
    "bundle/constitution.md",
    `---\ntype: constitution\ntitle: "Constitution — immutable hard limits"\ndate: ${date}\nimmutable: true\n${generated}\n` +
      `gated-actions: ["money-movement", "government-filing", "external-publishing", "credential-exposure", "access-expansion"]\n---\n\n` +
      `# Constitution\n\n**No agent may modify this file.** Enforcement lives in the harness, never in a prompt.\n\n` +
      `## Gated actions — never without explicit approval by ${answers.principalName}\n\n` +
      `1. Money movement\n2. Government filings\n3. External / public publishing\n4. Credential exposure\n5. Access expansion\n\n` +
      `## Standing rules\n\n- Autonomy ladder: L1 report-only → L2 draft-for-approval → L3 whitelisted reversible → L4 external (per-action gated, permanently). Every agent starts at L1.\n` +
      `- Least privilege: each agent holds only the credentials its job requires.\n` +
      `- Every agent action is appended to the ledger; an unlogged action is a verifier failure.\n` +
      `- Stable facts come from facts concepts, never model recall.\n\n` +
      `## Amendment\n\nOnly ${answers.principalName} may amend this file, by hand, recording a dated decision concept.\n`,
  );

  put(
    `bundle/${factsRel}`,
    `---\ntype: fact\ntitle: "${isPerson ? "Person" : "Organization"}"\ndate: ${date}\n${generated}\n---\n\n` +
      `# ${answers.orgName}\n\n` +
      (answers.description ? `${answers.description.trim()}\n\n` : "") +
      `- **Principal (approval gate):** ${answers.principalName}${answers.principalEmail ? ` <${answers.principalEmail}>` : ""}\n` +
      (persona
        ? `- **Mesh persona:** ${persona}${answers.personaEmails?.length ? ` <${answers.personaEmails.join(">, <")}>` : ""} — identity-plural: personas may share a mailbox via aliases\n`
        : "") +
      (answers.timezone ? `- **Timezone:** ${answers.timezone}\n` : "") +
      `\n> Every fact here starts unverified (no \`verified:\` key). Confirm it against a source document, then\n` +
      `> record the check: \`verified: { by: human:<id>, at: <ISO datetime> }\` plus the document under \`sources:\`.\n`,
  );

  put(
    "bundle/ops/calendar.md",
    `---\ntype: calendar\ntitle: "${isPerson ? "Obligations calendar" : "Compliance calendar"}"\ndate: ${date}\n${generated}\n---\n\n` +
      `# ${isPerson ? "Obligations calendar" : "Compliance calendar"}\n\n` +
      `The obligations the principal never again carries in their head. Agents read\nthis every heartbeat.\n\n` +
      `## Hard deadlines\n\n| Due | Item | State |\n|---|---|---|\n| _yyyy-mm-dd_ | _add your first hard deadline_ | not started |\n\n` +
      `## Recurring cycles\n\n| Cadence | Item |\n|---|---|\n| daily | agent heartbeats; report what needs the principal |\n\n` +
      `## One-time items outstanding\n\n- [ ] Replace these placeholders with ${isPerson ? "this person's" : "the organization's"} real obligations\n`,
  );

  // The priority dial (v2.3.5): starts as a template the principal fills in.
  const focusStale = new Date(`${date}T00:00:00Z`);
  focusStale.setUTCDate(focusStale.getUTCDate() + 30);
  put(
    "bundle/ops/focus.md",
    `---\ntype: focus\ntitle: "Focus - what matters right now"\n` +
      `description: The principal's priority dial; every agent reads it first and the brief follows it.\n` +
      `date: ${date}\nstale_after: ${focusStale.toISOString().replace(".000Z", "Z")}\nbrief: { lines: 3, also: 8 }\n${generated}\n---\n\n` +
      `# Focus\n\n` +
      `What matters right now. Every agent reads this first, every run; the daily\n` +
      `brief leads with the top of it and keeps the rest to one line each. Change it\n` +
      `whenever priorities move: by hand, or by asking the hub in chat once its\n` +
      `whitelist includes \`focus-update\`. It is fine to say nothing matters here now.\n\n` +
      `## Top of mind\n\n- _what the brief should lead with_\n\n` +
      `## Secondary\n\n- _one line each in the brief's Also list_\n\n` +
      `## Tertiary\n\n- _mentioned rarely, one line at most_\n\n` +
      `## Quiet (silent unless the exception fires)\n\n- _an area, and the exception that breaks the silence (a tax deadline, a legal notice)_\n\n` +
      `## Hands off (handled elsewhere; never raise or work on)\n\n- _a topic another session or person owns_\n`,
  );

  put(
    "bundle/ops/watch-list.md",
    `---\ntype: watchlist\ntitle: "Research / competitive watch-list"\ndate: ${date}\n${generated}\n---\n\n` +
      `# Watch-list\n\nSubjects the research/watch agent digests so signals surface without scanning.\n\n- _add your first watch subject_\n`,
  );

  put(
    "bundle/ops/schedule.md",
    `---\ntype: schedule\ntitle: "Schedule — overrides and one-shot wakes"\nwake: []\npause: []\ncadence: {}\n---\n\n` +
      `# Schedule — overrides and one-shot wakes\n\n` +
      `The due decision reads the frontmatter above at every beat:\n\n` +
      `- \`wake:\` — run these agents at the next beat regardless of cadence;\n` +
      `  consumed in the beat's own commit once the run is attempted.\n` +
      `- \`pause:\` — skip these agents until removed. Pause beats wake.\n` +
      `- \`cadence:\` — per-agent override of the concept's \`heartbeat:\` value\n` +
      `  (daily | weekly | monthly | quarterly).\n\n` +
      `Edit by hand and commit, or let a whitelisted agent request wakes with a\n` +
      `\`schedule-request\` block in its report. Next-fire time is derived from\n` +
      `cadence and the ledger — it is never stored here.\n`,
  );

  put(
    `bundle/${eventRel}`,
    `---\ntype: event\ntitle: "Instance created"\ndate: ${date}\n${generated}\n---\n\n` +
      `# Event: instance created — ${date}\n\nScaffolded by \`anima-mesh init\` for ${answers.orgName}. Append-only; corrections are new events.\n`,
  );

  put(
    "bundle/ops/engine-feedback.md",
    local
      ? `---\ntype: runbook\ntitle: "Engine feedback - kept inside this brain"\ndate: ${date}\n${generated}\n---\n\n` +
          `# Engine feedback - kept inside this brain\n\n` +
          `This brain runs in local mode: the engine never files issues from it, and its\n` +
          `knowledge must not appear in any public tracker. When an agent hits an engine\n` +
          `bug or a missing capability, it writes a draft under \`drafts/defects/\` and says so\n` +
          `in its report. The principal decides whether to describe the problem upstream,\n` +
          `by hand, in generic terms with no names, clients, data or internal details.\n`
      : fillTemplate(readFileSync(path.join(templatesDir(), "ops", "engine-feedback.md"), "utf8"), {
          DATE: date,
          GENERATED: generated,
        }),
  );

  // ── the standards pack: how any session (Claude Code, Codex, a person)
  // works in this brain, written into the brain itself (v2.3.6) ──────────
  const standards = standardsPack({ name: answers.orgName, principal: answers.principalName, local, isPerson });
  put("CLAUDE.md", standards);
  put("AGENTS.md", `# AGENTS.md\n\nThe working agreement for this brain is [CLAUDE.md](CLAUDE.md); it applies to every\nassistant and every person who edits the bundle.\n`);

  // ── agents from templates ────────────────────────────────────────────────
  const vars = {
    ORG_NAME: answers.orgName,
    PRINCIPAL_NAME: answers.principalName,
    PERSONA_NAME: persona ?? "Chief of Staff",
    DEFAULT_MODEL: model,
    DEFAULT_HARNESS: harness,
  };
  for (const agentName of agents) {
    const text = fillTemplate(loadAgentTemplate(agentName, kind), vars);
    put(`bundle/agents/${agentName}.md`, local ? localAgentText(text) : text);
  }

  // ── operational surfaces ─────────────────────────────────────────────────
  for (const dir of ["ledger", "approvals", "reports", "drafts"]) {
    put(`${dir}/.gitkeep`, "");
  }

  // ── local interactive surfaces: new instances get them out of the box ───
  // The hub's persona compiles into Claude Code + opencode agent artifacts
  // (same concept file all tiers run on — see local/agents-core.ts).
  const scaffoldBundle = await loadBundle(path.join(root, "bundle"));
  try {
    const selection = selectLocalAgents(agentsFromBundle(scaffoldBundle), config);
    for (const agentConcept of selection.agents) {
      for (const artifact of composeLocalAgents(agentConcept, config)) {
        put(artifact.relPath, artifact.content);
      }
    }
  } catch {
    /* roster without a hub (e.g. compliance-ops only) — local surfaces are opt-in via export-local */
  }

  // ── the acceptance test IS the scaffold's last step ─────────────────────
  const bundle = await loadBundle(path.join(root, "bundle"));
  const conformance = checkConformance(bundle, "animamesh");
  if (!conformance.ok) {
    throw new Error(
      `init produced a non-conformant bundle — this is an engine bug:\n` +
        conformance.issues.map((i) => `[${i.level}] ${i.rule} ${i.path ?? ""}: ${i.message}`).join("\n"),
    );
  }

  return { root, created, conformance };
}

/**
 * The working agreement written into every new brain (v2.3.6): the
 * standards the engine enforces or assumes - focus first, OKF v0.2
 * frontmatter, the two-tier layout, newest-first log, local indexes, the
 * untouchable constitution - so an interactive session in the brain, with
 * or without the engine installed, keeps the same practices. Local mode
 * adds its boundary.
 */
export function standardsPack(o: { name: string; principal: string; local: boolean; isPerson: boolean }): string {
  return [
    `# ${o.name} - working agreement`,
    "",
    `An AnimaMesh brain: an OKF v0.2 knowledge bundle plus the ledger, reports and`,
    `approvals around it. ${o.principal} is the principal and the approval gate. These`,
    `rules apply to every assistant session and every person who edits it.`,
    ...(o.local
      ? [
          "",
          "## Local mode: nothing leaves this machine",
          "",
          "`animamesh.config.json` sets `\"mode\": \"local\"`. The engine enforces it: reports go to the",
          "console and to files, no chat or mail delivery, no cloud drives or inboxes, no web search,",
          "no public engine issues, no cloud tier. Keep the same line by hand:",
          "",
          "- Never push this repository to a personal or public remote, and never copy its contents",
          "  into another brain, a public issue, a chat outside the organization, or a prompt for a",
          "  tool the organization has not approved.",
          "- The model harness is the one network path. Use only the assistant and account the",
          "  organization approves for this material.",
          "- Engine bugs become drafts under `drafts/defects/`; describing one upstream is the",
          "  principal's call, in generic terms with no internal details.",
        ]
      : []),
    "",
    "## Start every session here",
    "",
    "1. `bundle/ops/focus.md` - what matters right now. Work on top-of-mind items; give",
    "   secondary and tertiary ones a line at most; leave quiet areas alone unless their",
    "   exception fires; never touch hands-off topics.",
    "2. `bundle/index.md` - the map of areas; follow local indexes from there.",
    "3. `bundle/ops/nags.md` and `bundle/ops/calendar.md` - open asks and dates.",
    "",
    "## Writing memory (OKF v0.2)",
    "",
    "One concept per Markdown file, with frontmatter:",
    "",
    "```yaml",
    "---",
    "type: fact                  # required",
    'title: "One line"',
    "description: One sentence an index or search can use.",
    "date: 2026-01-31            # the domain date, YYYY-MM-DD",
    "generated: { by: <harness>/<model>, at: 2026-01-31T14:05:00-05:00 }",
    "sources:",
    '  - { id: original, resource: "where it came from", title: "what it is" }',
    "verified: { by: <who>, at: <when>, note: what was actually checked }   # only when true",
    "---",
    "```",
    "",
    "- `sources` say where a fact came from; cite claims with footnotes keyed to the id.",
    "- `verified` records a real check; without it a fact is a lead, not a basis for action.",
    "- `status` is lifecycle only (`draft` or `deprecated`); `stale_after` marks a shelf life.",
    "- Update evergreen facts in place; record what changed as a dated event or decision.",
    "",
    "## Where files go: two tiers, three at most",
    "",
    "- Below an area, dated memory splits by calendar year first (`events/2026/`,",
    "  `decisions/2026/`), evergreen memory by topic. A second level is optional (one",
    "  workspace, a month, a sub-topic); never a fourth folder.",
    "- Dated files are `YYYYMMDD-slug.md`; evergreen files keep stable names.",
    "- Every folder has an `index.md` listing its children with a short description (no",
    "  frontmatter, except the root's `okf_version`). Update it in the same change.",
    "- `bundle/log.md` is newest first: add a `## YYYY-MM-DD` group at the top and never",
    "  rewrite old entries. Events are append-only; a changed course is a new decision.",
    "- `bundle/constitution.md` is never edited by an assistant; only the principal",
    "  amends it, with a decision and a log entry.",
    "",
    "## The focus and the brief",
    "",
    "- The focus links out: list each item with a link to its record, and keep the",
    "  detail in the record. Records linked under Top of mind are what the hub reads in",
    "  full; moving an item out of focus changes nothing but its priority.",
    "- The daily brief is three lines (`## Brief`), a short `## Also` list, and a",
    "  `## Detail` that stays in the repo.",
    "",
    "## Checking your work",
    "",
    "From an AnimaMesh engine checkout: `pnpm cli validate <this brain>` must pass with no",
    "errors; fix warnings when you touch the files they name.",
    "",
  ].join("\n");
}

/**
 * A template agent as a local-mode brain gets it: network read sources and
 * the web budget removed from its frontmatter (the engine would refuse them
 * anyway), with a comment saying why, so the file does not promise reach
 * the brain will never have.
 */
export function localAgentText(text: string): string {
  const end = text.indexOf("\n---", 4);
  if (!text.startsWith("---\n") || end === -1) return text;
  let fm = text.slice(0, end);
  const rest = text.slice(end);
  // The comment block that introduces context-sources describes cloud setup.
  fm = fm.replace(/((?:^#.*\n)+)(?=context-sources:)/m, "");
  fm = fm.replace(/^context-sources:\s*\[([^\]]*)\]\s*$/m, (_m, list: string) => {
    const kept = list.split(",").map((x) => x.trim()).filter((x) => x && !["gmail", "google-calendar", "google-drive", "onedrive", "github-docs"].includes(x));
    const note = "# Local mode: no inbox, calendar, drive or remote docs; linked brains only from local checkouts.";
    return kept.length ? `${note}\ncontext-sources: [${kept.join(", ")}]` : note;
  });
  fm = fm.replace(/^((?:#.*\n)*)web:\s*\d+\s*$/m, "# Local mode: no web search; no query leaves the machine.");
  return fm + rest;
}
