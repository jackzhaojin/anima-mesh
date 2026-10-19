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
  const factsRel = isPerson ? "facts/person.md" : "facts/organization.md";
  const model = answers.defaultModel ?? "kimi-code/kimi-for-coding";
  const harness = answers.defaultHarness ?? "opencode";
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
      `explains the hub's narrow issue-filing grant and runtime credential setup.\n`,
  );

  // ── the bundle ───────────────────────────────────────────────────────────
  const agentLinks = agents.map((a) => `| [agents/${a}.md](agents/${a}.md) | ${a} (L1) |`).join("\n");
  put(
    "bundle/index.md",
    `---\nokf_version: "${OKF_VERSION}"\n---\n\n` +
      `# ${answers.orgName} — bundle index\n\n` +
      `Single source of truth for the ${answers.orgName} mesh, an OKF v${OKF_VERSION} bundle. One concept per\n` +
      `file; \`type\` required; this index and [log.md](log.md) (newest first) are reserved.\n\n` +
      `| Concept | What it holds |\n|---|---|\n` +
      `| [constitution.md](constitution.md) | Immutable hard limits — agents may not modify |\n` +
      `| [${factsRel}](${factsRel}) | ${isPerson ? "Who this person is - stable facts" : "The organization's stable facts"} |\n` +
      `| [ops/calendar.md](ops/calendar.md) | ${isPerson ? "Obligations calendar" : "Compliance calendar"} |\n` +
      `| [ops/watch-list.md](ops/watch-list.md) | Research / competitive watch |\n` +
      `| [ops/schedule.md](ops/schedule.md) | Schedule overrides and one-shot wakes |\n` +
      `| [ops/engine-feedback.md](ops/engine-feedback.md) | Core engine issue reporting: authorization, runtime setup, and filing evidence |\n` +
      `${agentLinks}\n`,
  );

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
    `bundle/events/${date}-instance-created.md`,
    `---\ntype: event\ntitle: "Instance created"\ndate: ${date}\n${generated}\n---\n\n` +
      `# Event: instance created — ${date}\n\nScaffolded by \`anima-mesh init\` for ${answers.orgName}. Append-only; corrections are new events.\n`,
  );

  put(
    "bundle/ops/engine-feedback.md",
    fillTemplate(readFileSync(path.join(templatesDir(), "ops", "engine-feedback.md"), "utf8"), {
      DATE: date,
      GENERATED: generated,
    }),
  );

  // ── agents from templates ────────────────────────────────────────────────
  const vars = {
    ORG_NAME: answers.orgName,
    PRINCIPAL_NAME: answers.principalName,
    PERSONA_NAME: persona ?? "Chief of Staff",
    DEFAULT_MODEL: model,
    DEFAULT_HARNESS: harness,
  };
  for (const agentName of agents) {
    put(`bundle/agents/${agentName}.md`, fillTemplate(loadAgentTemplate(agentName, kind), vars));
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
