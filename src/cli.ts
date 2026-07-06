#!/usr/bin/env node
import * as path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { loadBundle } from "./okf/bundle.js";
import { checkConformance, formatReport, type ConformanceProfile } from "./okf/conformance.js";
import { loadInstance, CONFIG_FILENAME } from "./instance/config.js";
import { runAgent } from "./harness/run.js";
import { formatResults } from "./harness/verifiers.js";
import { ApprovalStore } from "./gates/approvals.js";
import { Ledger } from "./ledger/ledger.js";
import { scaffoldBrain } from "./init/scaffold.js";
import { loadAnswersFile, interactiveInterview, normalizeAnswers, agenticEnrich } from "./init/interview.js";
import { listAgentTemplates } from "./init/templates.js";
import { resolveProvider } from "./providers/index.js";
import { agentsFromBundle } from "./agents/concept.js";

/**
 * anima-mesh CLI — init / validate / run / gate / report.
 * Exported as main(argv) → exit code so the regression suite drives it
 * without subprocesses.
 */
export async function main(argv: string[], io: { log: (s: string) => void; error: (s: string) => void } = console): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "init":
        return await cmdInit(rest, io);
      case "validate":
        return await cmdValidate(rest, io);
      case "run":
        return await cmdRun(rest, io);
      case "gate":
        return await cmdGate(rest, io);
      case "report":
        return await cmdReport(rest, io);
      case "templates":
        io.log(listAgentTemplates().join("\n"));
        return 0;
      case undefined:
      case "help":
      case "--help":
        io.log(usage());
        return command ? 0 : 2;
      default:
        io.error(`unknown command: ${command}\n\n${usage()}`);
        return 2;
    }
  } catch (err) {
    io.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function usage(): string {
  return [
    "anima-mesh — the engine that animates a company-of-0 brain",
    "",
    "Usage:",
    "  anima-mesh init <dir> [--answers file.json] [--agentic [harness]] ",
    "                        [--org NAME --principal NAME] [--agents a,b,c]",
    "  anima-mesh validate <dir> [--profile okf|animamesh]",
    "  anima-mesh run <agent> [--instance dir]",
    "  anima-mesh gate list|approve <id>|deny <id> [--instance dir] [--by NAME] [--note TEXT]",
    "  anima-mesh report [--instance dir]",
    "  anima-mesh templates",
  ].join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const val = args[idx + 1];
  return val && !val.startsWith("--") ? val : "";
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

async function cmdInit(args: string[], io: { log: (s: string) => void; error: (s: string) => void }): Promise<number> {
  const target = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
  if (!target) {
    io.error("init: target directory required");
    return 2;
  }
  const answersFile = flag(args, "answers");
  let answers;
  if (answersFile) {
    answers = loadAnswersFile(answersFile);
  } else if (flag(args, "org") !== undefined && flag(args, "principal") !== undefined) {
    answers = normalizeAnswers({
      orgName: flag(args, "org")!,
      principalName: flag(args, "principal")!,
      personaName: flag(args, "persona") || undefined,
      description: flag(args, "description") || undefined,
      agents: (flag(args, "agents") ?? "compliance-ops").split(",").map((s) => s.trim()).filter(Boolean),
      defaultModel: flag(args, "model") || undefined,
      defaultHarness: flag(args, "harness") || undefined,
    });
  } else {
    answers = await interactiveInterview();
  }

  if (hasFlag(args, "agentic")) {
    const harnessName = flag(args, "agentic") || "opencode";
    const provider = resolveProvider(harnessName);
    provider.assertConfigured();
    io.log(`agentic init: refining answers via ${provider.name}…`);
    answers = await agenticEnrich(answers, provider);
  }

  const result = await scaffoldBrain(target, answers);
  io.log(`scaffolded ${result.created.length} files into ${result.root}`);
  io.log(formatReport(result.conformance));
  return result.conformance.ok ? 0 : 1;
}

async function cmdValidate(args: string[], io: { log: (s: string) => void }): Promise<number> {
  const target = args.find((a) => !a.startsWith("--")) ?? ".";
  const profile = (flag(args, "profile") as ConformanceProfile) || "animamesh";
  const root = path.resolve(target);
  // Instance dir (has config) → validate its bundle; otherwise treat as a bundle dir.
  const bundleDir = existsSync(path.join(root, CONFIG_FILENAME)) ? loadInstance(root).bundleDir : root;
  const bundle = await loadBundle(bundleDir);
  const report = checkConformance(bundle, profile);
  io.log(formatReport(report));
  return report.ok ? 0 : 1;
}

async function cmdRun(args: string[], io: { log: (s: string) => void }): Promise<number> {
  const agentName = args.find((a) => !a.startsWith("--"));
  if (!agentName) throw new Error("run: agent name required");
  const instanceRoot = flag(args, "instance") ?? ".";
  const report = await runAgent({
    instanceRoot,
    agentName,
    onProgress: (note) => io.log(`  ${note}`),
  });
  io.log(`\nrun ${report.runId} — ${report.ok ? "OK" : "FAILED VERIFICATION"}`);
  io.log(formatResults(report.verifierResults));
  io.log(`report: ${report.reportPath}`);
  return report.ok ? 0 : 1;
}

async function cmdGate(args: string[], io: { log: (s: string) => void }): Promise<number> {
  const sub = args[0];
  const instanceRoot = flag(args, "instance") ?? ".";
  const instance = loadInstance(instanceRoot);
  const store = new ApprovalStore(instance.approvalsDir);

  if (sub === "list") {
    const records = store.list();
    if (records.length === 0) {
      io.log("no approval records");
      return 0;
    }
    for (const r of records) {
      io.log(`${r.status.toUpperCase().padEnd(8)} ${r.id}  ${r.actionType}  ${r.summary}  (by ${r.requestedBy} @ ${r.requestedAt})`);
    }
    return 0;
  }
  if (sub === "approve" || sub === "deny") {
    const id = args[1];
    if (!id) throw new Error(`gate ${sub}: approval id required`);
    const by = flag(args, "by") ?? "principal";
    const record = store.decide(id, sub === "approve" ? "approved" : "denied", by, flag(args, "note"));
    io.log(`${record.status}: ${record.id} (${record.actionType}) by ${record.decidedBy}`);
    return 0;
  }
  throw new Error("gate: expected list|approve <id>|deny <id>");
}

async function cmdReport(args: string[], io: { log: (s: string) => void }): Promise<number> {
  const instanceRoot = flag(args, "instance") ?? ".";
  const instance = loadInstance(instanceRoot);
  const bundle = await loadBundle(instance.bundleDir);

  io.log(`# Instance status — ${instance.root}`);

  const agents = agentsFromBundle(bundle);
  io.log(`\n## Agents (${agents.length})`);
  for (const a of agents) {
    io.log(`- ${a.name} [${a.level}] ${a.harness}/${a.model}${a.commercial ? " (commercial, dual-gated)" : ""}`);
  }

  const pending = new ApprovalStore(instance.approvalsDir).list("pending");
  io.log(`\n## Pending approvals (${pending.length})`);
  for (const p of pending) io.log(`- ${p.id}: ${p.actionType} — ${p.summary}`);

  const ledger = new Ledger(instance.ledgerFile);
  const entries = ledger.read().slice(-10);
  io.log(`\n## Last ${entries.length} ledger entries`);
  for (const e of entries) io.log(`- ${e.ts} ${e.agent} ${e.action} (${e.type})`);

  if (existsSync(instance.reportsDir)) {
    const reports = readdirSync(instance.reportsDir).filter((f) => f.endsWith(".md")).sort().slice(-5);
    io.log(`\n## Latest reports`);
    for (const r of reports) {
      const firstLine = readFileSync(path.join(instance.reportsDir, r), "utf8").split("\n").find((l) => l.startsWith("# ") || l.startsWith("## "));
      io.log(`- ${r}${firstLine ? ` — ${firstLine.replace(/^#+\s*/, "")}` : ""}`);
    }
  }
  return 0;
}

// Entry point when invoked as a binary (not imported by tests).
const invokedDirectly = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
