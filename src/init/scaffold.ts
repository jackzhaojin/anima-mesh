import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { loadBundle } from "../okf/bundle.js";
import { checkConformance, type ConformanceReport } from "../okf/conformance.js";
import { CONFIG_FILENAME, type InstanceConfig } from "../instance/config.js";
import { fillTemplate, loadAgentTemplate } from "./templates.js";

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
  /** Injectable clock for deterministic tests. */
  now?: string;
}

export interface ScaffoldResult {
  root: string;
  created: string[];
  conformance: ConformanceReport;
}

const DEFAULT_AGENTS = ["compliance-ops"];

export async function scaffoldBrain(targetDir: string, answers: InitAnswers): Promise<ScaffoldResult> {
  const root = path.resolve(targetDir);
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`target directory ${root} is not empty — init only scaffolds from nothing`);
  }
  const nowIso = answers.now ?? new Date().toISOString();
  const date = nowIso.slice(0, 10);
  const agents = answers.agents.length > 0 ? answers.agents : DEFAULT_AGENTS;
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
    engine: { repo: answers.engineRepo ?? "github.com/jackzhaojin/anima-mesh", ref: answers.engineRef ?? "main" },
    identity: {
      principal: { name: answers.principalName, ...(answers.principalEmail ? { email: answers.principalEmail } : {}) },
      ...(persona
        ? { persona: { name: persona, ...(answers.personaEmails?.length ? { emails: answers.personaEmails } : {}) } }
        : {}),
    },
    activation: { boundaryMapVerified: false, optionTrigger: null, founderWaiver: false },
  };
  put(CONFIG_FILENAME, JSON.stringify(config, null, 2) + "\n");

  put(
    ".gitignore",
    ["# secrets never enter the brain repo", ".env", ".env.*", "", "node_modules/", ".DS_Store", ""].join("\n"),
  );

  put(
    "README.md",
    `# ${answers.orgName} — brain\n\n` +
      `Private AnimaMesh instance: an OKF knowledge bundle plus the operational\n` +
      `surfaces (ledger, approvals, reports) for a company-of-0 mesh.\n\n` +
      `- Engine: ${config.engine!.repo} @ ${config.engine!.ref}\n` +
      `- Principal: ${answers.principalName} (the approval gate)\n` +
      (persona ? `- Mesh persona: ${persona}\n` : "") +
      `\nValidate: \`anima-mesh validate .\` · Run an agent: \`anima-mesh run <name>\`\n`,
  );

  // ── the bundle ───────────────────────────────────────────────────────────
  const agentLinks = agents.map((a) => `| [agents/${a}.md](agents/${a}.md) | ${a} (L1) |`).join("\n");
  put(
    "bundle/index.md",
    `---\ntype: index\ntitle: "${answers.orgName} — brain bundle index"\ndate: ${date}\n---\n\n` +
      `# ${answers.orgName} — bundle index\n\n` +
      `Single source of truth for the ${answers.orgName} mesh. One concept per file;\n` +
      `\`type\` required; [log.md](log.md) is append-only.\n\n` +
      `| Concept | What it holds |\n|---|---|\n` +
      `| [constitution.md](constitution.md) | Immutable hard limits — agents may not modify |\n` +
      `| [facts/organization.md](facts/organization.md) | The organization's stable facts |\n` +
      `| [ops/calendar.md](ops/calendar.md) | Compliance calendar |\n` +
      `| [ops/watch-list.md](ops/watch-list.md) | Research / competitive watch |\n` +
      `| [ops/schedule.md](ops/schedule.md) | Schedule overrides and one-shot wakes |\n` +
      `${agentLinks}\n`,
  );

  put(
    "bundle/log.md",
    `---\ntype: log\ntitle: "Bundle log — append-only"\n---\n\n# Bundle log\n\n` +
      `- **${date}** — Brain scaffolded by \`anima-mesh init\` (engine ${config.engine!.ref}). ` +
      `Agents: ${agents.join(", ")}. All facts start unverified until confirmed against source documents.\n`,
  );

  put(
    "bundle/constitution.md",
    `---\ntype: constitution\ntitle: "Constitution — immutable hard limits"\ndate: ${date}\nimmutable: true\n` +
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
    "bundle/facts/organization.md",
    `---\ntype: fact\ntitle: "Organization"\nstatus: unverified\ndate: ${date}\n---\n\n` +
      `# ${answers.orgName}\n\n` +
      (answers.description ? `${answers.description.trim()}\n\n` : "") +
      `- **Principal (approval gate):** ${answers.principalName}${answers.principalEmail ? ` <${answers.principalEmail}>` : ""}\n` +
      (persona
        ? `- **Mesh persona:** ${persona}${answers.personaEmails?.length ? ` <${answers.personaEmails.join(">, <")}>` : ""} — identity-plural: personas may share a mailbox via aliases\n`
        : "") +
      (answers.timezone ? `- **Timezone:** ${answers.timezone}\n` : "") +
      `\n> Every fact here starts \`unverified\`. Verify against source documents (a librarian pass), then flip the status.\n`,
  );

  put(
    "bundle/ops/calendar.md",
    `---\ntype: calendar\ntitle: "Compliance calendar"\nstatus: active\ndate: ${date}\n---\n\n` +
      `# Compliance calendar\n\n` +
      `The obligations the principal never again carries in their head. Agents read\nthis every heartbeat.\n\n` +
      `## Hard deadlines\n\n| Due | Item | State |\n|---|---|---|\n| _yyyy-mm-dd_ | _add your first hard deadline_ | not started |\n\n` +
      `## Recurring cycles\n\n| Cadence | Item |\n|---|---|\n| daily | agent heartbeats; report what needs the principal |\n\n` +
      `## One-time items outstanding\n\n- [ ] Replace these placeholders with the organization's real obligations\n`,
  );

  put(
    "bundle/ops/watch-list.md",
    `---\ntype: watchlist\ntitle: "Research / competitive watch-list"\nstatus: active\ndate: ${date}\n---\n\n` +
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
    `---\ntype: event\ntitle: "Instance created"\nstatus: verified\ndate: ${date}\n---\n\n` +
      `# Event: instance created — ${date}\n\nScaffolded by \`anima-mesh init\` for ${answers.orgName}. Append-only; corrections are new events.\n`,
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
    put(`bundle/agents/${agentName}.md`, fillTemplate(loadAgentTemplate(agentName), vars));
  }

  // ── operational surfaces ─────────────────────────────────────────────────
  for (const dir of ["ledger", "approvals", "reports", "drafts"]) {
    put(`${dir}/.gitkeep`, "");
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
