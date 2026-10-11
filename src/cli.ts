#!/usr/bin/env node
import * as path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { loadBundle } from "./okf/bundle.js";
import { checkConformance, formatReport, type ConformanceProfile } from "./okf/conformance.js";
import { diskLinkChecker } from "./okf/conformance-fs.js";
import "./providers/node-providers.js"; // register subprocess providers
import { loadInstance, CONFIG_FILENAME } from "./instance/config.js";
import { loadInstanceEnv } from "./instance/env.js";
import { GitHubInstanceStore } from "./instance/store-github.js";
import { githubToken } from "./instance/github-auth.js";
import { runAgent } from "./harness/run.js";
import { formatResults } from "./harness/verifiers.js";
import { ApprovalStore } from "./gates/approvals.js";
import { Ledger } from "./ledger/ledger.js";
import { scaffoldBrain } from "./init/scaffold.js";
import { loadAnswersFile, interactiveInterview, normalizeAnswers, agenticEnrich } from "./init/interview.js";
import { listAgentTemplates } from "./init/templates.js";
import { resolveProvider } from "./providers/index.js";
import { agentsFromBundle } from "./agents/concept.js";
import { deliverLatestReport } from "./channels/index.js";
import { heartbeat } from "./harness/heartbeat.js";
import { buildAgentCard } from "./a2a/card.js";
import { exportLocalAgents } from "./local/agents.js";
import { listDefectDrafts, fileDefectDrafts } from "./defects/file.js";
import { inspectBrains, syncInherited } from "./brains/inspect.js";
import { brainIssues, assertMayDecide, BRAIN_KINDS } from "./brains/core.js";
import { connectGoogle } from "./connect/google.js";
import { buildOntology, formatOntology } from "./okf/ontology.js";
import type { BrainKind } from "./instance/config-core.js";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

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
      case "deliver":
        return await cmdDeliver(rest, io);
      case "heartbeat":
        return await cmdHeartbeat(rest, io);
      case "card":
        return await cmdCard(rest, io);
      case "export-local":
        return await cmdExportLocal(rest, io);
      case "defect":
        return await cmdDefect(rest, io);
      case "brains":
        return await cmdBrains(rest, io);
      case "connect":
        return await cmdConnect(rest, io);
      case "ontology":
        return await cmdOntology(rest, io);
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
    "  anima-mesh init <dir> [--answers file.json] [--agentic [harness]]",
    "                        [--org NAME | --name NAME] [--principal NAME] [--principal-email EMAIL]",
    "                        [--kind person|org|team|group] [--brain-id ID] [--agents a,b,c]",
    "                        [--persona NAME] [--description TEXT]",
    "                        [--model MODEL] [--harness HARNESS]",
    "  anima-mesh validate <dir> [--profile okf|animamesh]",
    "  anima-mesh run <agent> [--instance dir | --instance github:owner/repo#ref]",
    "  anima-mesh gate list|approve <id>|deny <id> [--instance dir] [--by NAME] [--note TEXT]",
    "  anima-mesh report [--instance dir]",
    "  anima-mesh heartbeat [--instance dir] [--dry-run] [--no-deliver]",
    "  anima-mesh deliver [--instance dir] [--agent NAME] [--channel c1,c2]",
    "  anima-mesh card [--instance dir] [--out FILE]",
    "  anima-mesh export-local [--instance dir] [--agents a,b | --all]",
    "  anima-mesh defect list|file <slug>|file --all [--instance dir]",
    "  anima-mesh brains [--instance dir]          who this brain is, its links, who can see what",
    "  anima-mesh brains sync [--instance dir]     materialize ancestor constitutions (child brains)",
    "  anima-mesh ontology [--instance dir]        type catalog, schemas, link types, cross-brain refs",
    "  anima-mesh connect google [--instance dir] [--port N] [--no-open]",
    "                        one-time READ-ONLY Gmail + Calendar consent for the principal",
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
  } else if ((flag(args, "org") !== undefined || flag(args, "name") !== undefined) && flag(args, "principal") !== undefined) {
    const kind = flag(args, "kind") || undefined;
    if (kind !== undefined && !BRAIN_KINDS.includes(kind as BrainKind)) {
      io.error(`init: --kind must be one of ${BRAIN_KINDS.join("|")}`);
      return 2;
    }
    answers = normalizeAnswers({
      orgName: (flag(args, "org") ?? flag(args, "name"))!,
      principalName: flag(args, "principal")!,
      principalEmail: flag(args, "principal-email") || undefined,
      brainKind: kind as BrainKind | undefined,
      brainId: flag(args, "brain-id") || undefined,
      personaName: flag(args, "persona") || undefined,
      description: flag(args, "description") || undefined,
      // No --agents: the scaffold picks the kind's default roster.
      agents: (flag(args, "agents") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
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
  const instance = existsSync(path.join(root, CONFIG_FILENAME)) ? loadInstance(root) : undefined;
  const bundle = await loadBundle(instance?.bundleDir ?? root);
  const report = checkConformance(bundle, profile, { linkExists: diskLinkChecker });
  if (instance) {
    // Config-aware checks (v0.18.0): the link map, members, and share
    // markings only make sense against the instance config.
    report.issues.push(...brainIssues(bundle, instance.config));
    report.ok = !report.issues.some((i) => i.level === "error");
  }
  io.log(formatReport(report));
  return report.ok ? 0 : 1;
}

async function cmdRun(args: string[], io: { log: (s: string) => void }): Promise<number> {
  const agentName = args.find((a) => !a.startsWith("--"));
  if (!agentName) throw new Error("run: agent name required");
  const instanceRoot = flag(args, "instance") ?? ".";

  // github:owner/name#ref — run against a remote brain, zero local file
  // reads. Env (GITHUB_TOKEN, model keys) comes from any .env/.env.local in
  // the CURRENT directory plus process.env — run from the instance checkout
  // to pick up its keys.
  let report;
  if (instanceRoot.startsWith("github:")) {
    const spec = instanceRoot.slice("github:".length);
    const [repo, ref] = spec.split("#") as [string, string | undefined];
    if (!/^[^/]+\/[^/#]+$/.test(repo)) {
      throw new Error(`run: bad github instance '${instanceRoot}' — expected github:owner/name[#ref]`);
    }
    const env = loadInstanceEnv(process.cwd());
    const store = new GitHubInstanceStore({ repo, ref, token: await githubToken(env) });
    report = await runAgent({
      store,
      agentName,
      providerCtx: { env },
      consumeWake: true,
      onProgress: (note) => io.log(`  ${note}`),
    });
  } else {
    report = await runAgent({
      instanceRoot,
      agentName,
      consumeWake: true,
      onProgress: (note) => io.log(`  ${note}`),
    });
  }
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
    // Multi-player: with members declared, the decider must be an owner or
    // approver member - checked in code before the record changes.
    const member = assertMayDecide(instance.config, by);
    const record = store.decide(id, sub === "approve" ? "approved" : "denied", member?.id ?? by, flag(args, "note"));
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

async function cmdDeliver(args: string[], io: { log: (s: string) => void }): Promise<number> {
  const instanceRoot = flag(args, "instance") ?? ".";
  const results = await deliverLatestReport(instanceRoot, {
    agent: flag(args, "agent") || undefined,
    channels: flag(args, "channel") ? flag(args, "channel")!.split(",").map((s) => s.trim()) : undefined,
    log: io.log,
  });
  for (const r of results) io.log(`${r.ok ? "✓" : "✗"} ${r.channel}: ${r.detail}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

async function cmdHeartbeat(args: string[], io: { log: (s: string) => void }): Promise<number> {
  const instanceRoot = flag(args, "instance") ?? ".";
  const dryRun = hasFlag(args, "dry-run");
  const result = await heartbeat({ instanceRoot, dryRun, onProgress: (n) => io.log(`  ${n}`) });

  io.log(`due: ${result.due.length ? result.due.map((d) => `${d.agent} (${d.reason})`).join(", ") : "none"}`);
  for (const s of result.skipped) io.log(`  skip ${s.agent}: ${s.reason}`);
  if (dryRun) return 0;

  for (const run of result.runs) {
    io.log(`${run.ok ? "✓" : "✗"} ${run.agent} run ${run.runId.slice(0, 8)} → ${run.reportPath}`);
  }
  for (const failure of result.failures) {
    io.log(`✗ ${failure.agent} FAILED: ${failure.error.slice(0, 300)}`);
  }

  // Deliver the hub's brief when configured and freshly produced.
  const instance = loadInstance(instanceRoot);
  const deliverAgent = instance.config.delivery?.deliverAgent;
  const channels = instance.config.delivery?.channels ?? [];
  if (!hasFlag(args, "no-deliver") && deliverAgent && channels.length > 0 && result.runs.some((r) => r.agent === deliverAgent && r.ok)) {
    const results = await deliverLatestReport(instanceRoot, { log: io.log });
    for (const r of results) io.log(`${r.ok ? "✓" : "✗"} delivered via ${r.channel}: ${r.detail}`);
  }
  return result.ok ? 0 : 1;
}

async function cmdCard(args: string[], io: { log: (s: string) => void }): Promise<number> {
  const instanceRoot = flag(args, "instance") ?? ".";
  const card = await buildAgentCard(instanceRoot);
  const json = JSON.stringify(card, null, 2);
  const out = flag(args, "out");
  if (out) {
    writeFileSync(out, json + "\n", "utf8");
    io.log(`agent card written to ${out}`);
  } else {
    io.log(json);
  }
  return 0;
}

async function cmdExportLocal(args: string[], io: { log: (s: string) => void }): Promise<number> {
  const instanceRoot = flag(args, "instance") ?? ".";
  const agentsFlag = flag(args, "agents");
  const result = await exportLocalAgents(instanceRoot, {
    names: agentsFlag ? agentsFlag.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    all: hasFlag(args, "all"),
  });
  for (const rel of result.written) io.log(`wrote ${rel}`);
  for (const s of result.skipped) io.log(`skipped ${s.name}: ${s.reason}`);
  io.log(
    result.written.length > 0
      ? "local agents exported — regenerate after editing bundle agent files or identity config"
      : "nothing exported",
  );
  return 0;
}

async function cmdDefect(args: string[], io: { log: (s: string) => void; error: (s: string) => void }): Promise<number> {
  // Positionals = tokens that neither are flags nor follow a flag — so
  // `defect file <slug> --instance <dir>` never reads <dir> as a slug.
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1]?.startsWith("--") !== true);
  const sub = positional[0];
  const instanceRoot = flag(args, "instance") ?? ".";
  if (sub === "list" || sub === undefined) {
    const drafts = listDefectDrafts(instanceRoot);
    if (drafts.length === 0) {
      io.log("no defect drafts");
      return 0;
    }
    for (const d of drafts) {
      const status = d.filedUrl ? `filed ${d.filedUrl}` : d.leaked.length > 0 ? `LEAKY (${d.leaked.join(", ")})` : "unfiled";
      io.log(`${d.slug} — ${d.title} [${status}]`);
    }
    return 0;
  }
  if (sub === "file") {
    const slugs = positional.slice(1);
    const all = hasFlag(args, "all");
    if (!all && slugs.length === 0) {
      io.error("defect file: name a draft slug or pass --all");
      return 2;
    }
    // Local, deliberate step: env token first, else the founder's gh session.
    let token = process.env.GITHUB_DEFECTS_TOKEN ?? process.env.GITHUB_TOKEN;
    if (!token) {
      try {
        token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
      } catch {
        /* gh absent/unauthenticated */
      }
    }
    if (!token) {
      io.error("defect file: no credential — set GITHUB_DEFECTS_TOKEN, GITHUB_TOKEN, or authenticate `gh`");
      return 1;
    }
    const result = await fileDefectDrafts({ instanceRoot, slugs: all ? undefined : slugs, all, token });
    for (const f of result.filed) io.log(`filed ${f.slug} → ${f.url}${f.duplicate ? " (already open — deduped)" : ""}`);
    for (const s of result.skipped) io.log(`skipped ${s.slug}: ${s.reason}`);
    return 0;
  }
  io.error(`defect: unknown subcommand '${sub}' (use list|file)`);
  return 2;
}

async function cmdBrains(args: string[], io: { log: (s: string) => void; error: (s: string) => void }): Promise<number> {
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1]?.startsWith("--") !== true);
  const sub = positional[0];
  const instanceRoot = path.resolve(flag(args, "instance") ?? ".");
  const env = loadInstanceEnv(instanceRoot);
  if (sub === undefined || sub === "show" || sub === "check") {
    const result = await inspectBrains(instanceRoot, env);
    io.log(result.text);
    return result.ok ? 0 : 1;
  }
  if (sub === "sync") {
    const result = await syncInherited(instanceRoot, env);
    if (result.note) io.log(result.note);
    for (const rel of result.written) io.log(`wrote bundle/${rel}`);
    for (const rel of result.unchanged) io.log(`current bundle/${rel}`);
    return 0;
  }
  io.error(`brains: unknown subcommand '${sub}' (use show|sync)`);
  return 2;
}

async function cmdOntology(args: string[], io: { log: (s: string) => void }): Promise<number> {
  const target = path.resolve(flag(args, "instance") ?? args.find((a) => !a.startsWith("--")) ?? ".");
  const instance = existsSync(path.join(target, CONFIG_FILENAME)) ? loadInstance(target) : undefined;
  const bundle = await loadBundle(instance?.bundleDir ?? target);
  const brain = instance?.config.brain;
  io.log(formatOntology(buildOntology(bundle), brain ? `${brain.id} (${brain.kind})` : path.basename(target)));
  return 0;
}

async function cmdConnect(args: string[], io: { log: (s: string) => void; error: (s: string) => void }): Promise<number> {
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1]?.startsWith("--") !== true);
  if (positional[0] !== "google") {
    io.error("connect: the only connector is `google` (read-only Gmail + Calendar for the principal)");
    return 2;
  }
  const port = flag(args, "port");
  const result = await connectGoogle({
    instanceRoot: flag(args, "instance") ?? ".",
    port: port ? Number(port) : 0,
    openBrowser: !hasFlag(args, "no-open"),
    log: io.log,
  });
  io.log(`connected${result.account ? ` ${result.account}` : ""} - scopes: ${result.scopes.join(", ")}`);
  io.log(`GOOGLE_READ_REFRESH_TOKEN stored in ${result.envFile} (mode 600; value not shown). For the cloud tier, load it with wrangler secret put.`);
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
