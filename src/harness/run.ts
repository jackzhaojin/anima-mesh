import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { loadBundle, getConcept } from "../okf/bundle.js";
import { loadInstance, type ResolvedInstance } from "../instance/config.js";
import { findAgent, assertActivatable, type AgentConcept } from "../agents/concept.js";
import { Ledger } from "../ledger/ledger.js";
import { ApprovalStore } from "../gates/approvals.js";
import { loadGatedTypes, assertActionAllowed } from "../gates/gatekeeper.js";
import { resolveProvider, type AgentWorkerProvider } from "../providers/index.js";
import {
  verifyConformance,
  verifyExpectedOutputs,
  verifyGateAssertions,
  verifyLedgerCompleteness,
  allOk,
  type VerifierResult,
} from "./verifiers.js";

/**
 * One heartbeat run: wake → assemble context from the bundle → model
 * judgment via the provider chokepoint → harness writes the artifact →
 * deterministic verifiers. The agent's correctness is judged ONLY by what
 * changed in the instance (the one seam); its internals are not a surface.
 *
 * Deterministic code here is confined to D5's four jobs: trigger plumbing,
 * gate enforcement, ledger appends, and verifiers. Everything between
 * wake-up and gate is the model's judgment.
 */
export interface RunOptions {
  instanceRoot: string;
  agentName: string;
  /** Test seam: inject a provider (e.g. FakeProvider) instead of resolving the concept's harness. */
  provider?: AgentWorkerProvider;
  runId?: string;
  now?: Date;
  onProgress?: (note: string) => void;
}

export interface RunReport {
  runId: string;
  agent: string;
  harness: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  reportPath: string;
  verifierResults: VerifierResult[];
  ok: boolean;
  text: string;
}

const DECLARED_ACTIONS = ["run-started", "report-written", "run-completed"];

export async function runAgent(options: RunOptions): Promise<RunReport> {
  const instance = loadInstance(options.instanceRoot);
  const bundle = await loadBundle(instance.bundleDir);
  const agent = findAgent(bundle, options.agentName);
  const progress = options.onProgress ?? (() => {});

  // D11 dual gate — commercial capability never runs without permission.
  assertActivatable(agent, instance.config);

  const ledger = new Ledger(instance.ledgerFile);
  const approvals = new ApprovalStore(instance.approvalsDir);
  const gatedTypes = loadGatedTypes(bundle);

  // The run's artifact category must be within the agent's ladder level —
  // checked in code before any model is invoked.
  assertActionAllowed({
    agent: agent.name,
    level: agent.level,
    category: "report",
    actionType: "report",
    gatedTypes,
    approvals,
  });

  const runId = options.runId ?? randomUUID();
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  // Injected clock ⇒ fully frozen timestamps (deterministic simulations);
  // real runs keep wall-clock precision per entry.
  const clock = options.now ? () => startedAt : () => new Date().toISOString();
  // Local date, not UTC: a daily brief stamped "tomorrow" confuses its reader.
  const dateStamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");

  ledger.append({ ts: startedAt, runId, agent: agent.name, action: "run-started", type: "report" });

  const prompt = buildPrompt(agent, bundle.root, instance, dateStamp);
  const provider = options.provider ?? resolveProvider(agent.harness);
  provider.assertConfigured();
  progress(`run ${runId.slice(0, 8)}: ${agent.name} via ${provider.name} (${agent.model})`);

  // The bundle IS the agent's working world: relative reads in any harness
  // resolve against the knowledge layer, matching the prompt's paths.
  const result = await provider.run({
    prompt,
    cwd: instance.bundleDir,
    model: agent.model,
    onProgress: progress,
  });

  // L1 contract: the harness, not the agent, writes the artifact.
  mkdirSync(instance.reportsDir, { recursive: true });
  const reportPath = path.join(instance.reportsDir, `${dateStamp}-${agent.name}-${runId.slice(0, 8)}.md`);
  const reportContent = [
    "---",
    "type: report",
    `agent: ${agent.name}`,
    `runId: ${runId}`,
    `date: ${dateStamp}`,
    `harness: ${provider.name}`,
    `model: ${agent.model}`,
    "---",
    "",
    result.text.trim(),
    "",
  ].join("\n");
  writeFileSync(reportPath, reportContent, "utf8");
  ledger.append({
    ts: clock(),
    runId,
    agent: agent.name,
    action: "report-written",
    type: "report",
    detail: { path: path.relative(instance.root, reportPath) },
  });

  const finishedAt = clock();
  ledger.append({ ts: finishedAt, runId, agent: agent.name, action: "run-completed", type: "report" });

  const verifierResults: VerifierResult[] = [
    await verifyConformance(instance.bundleDir, "animamesh"),
    verifyExpectedOutputs([reportPath]),
    verifyGateAssertions(ledger, approvals, gatedTypes, runId),
    verifyLedgerCompleteness(ledger, runId, DECLARED_ACTIONS),
  ];

  return {
    runId,
    agent: agent.name,
    harness: provider.name,
    model: agent.model,
    startedAt,
    finishedAt,
    reportPath,
    verifierResults,
    ok: allOk(verifierResults),
    text: result.text,
  };
}

/**
 * Context assembly: the agent's job description plus the operational
 * concepts it wakes to (calendar, watch-list, index) inlined so L1 runs
 * need no tool access at all.
 */
function buildPrompt(agent: AgentConcept, bundleRoot: string, instance: ResolvedInstance, dateStamp: string): string {
  const sections: string[] = [];
  sections.push(
    `You are "${agent.title}" (${agent.name}), an agent in an AnimaMesh company-of-0 mesh.`,
    `Today is ${dateStamp}. Autonomy level: ${agent.level} (${levelMeaning(agent.level)}).`,
    "",
    "## Your job",
    agent.job,
    "",
    "## Operating rules",
    "- Your working directory is the bundle root: paths like `ops/calendar.md` and `facts/*.md` resolve directly.",
    "- Base every claim about stable facts on the bundle excerpts below — never on recall.",
    "- You produce a single markdown report. The harness writes it to disk; you cause no side effects.",
    "- If something needs the principal's decision or approval, say so explicitly in a `## Needs you` section.",
    "- If nothing needs attention, say so plainly — a short honest report beats an inflated one.",
  );
  return [
    sections.join("\n"),
    bundleContext(instance),
    instanceContext(instance),
    "\n## Output\nReturn ONLY the markdown body of your report (no code fences around the whole thing).",
  ].join("\n");
}

function levelMeaning(level: string): string {
  switch (level) {
    case "L1": return "report-only";
    case "L2": return "draft-for-approval";
    case "L3": return "whitelisted reversible actions";
    case "L4": return "external actions, each behind a human gate";
    default: return "unknown";
  }
}

function bundleContext(instance: ResolvedInstance): string {
  // Synchronous, tolerant reads — a missing ops file is context absence, not a crash.
  const parts: string[] = ["\n## Bundle context (source of truth excerpts)"];
  // ops/nags.md: the persistent-reminder surface — principals opt in to being
  // bugged every heartbeat until an item is done. Inlined for EVERY agent.
  for (const rel of ["index.md", "ops/calendar.md", "ops/watch-list.md", "ops/nags.md"]) {
    try {
      const raw = readFileSync(path.join(instance.bundleDir, rel), "utf8");
      parts.push(`\n### ${rel}\n\n${raw}`);
    } catch {
      /* concept not present in this instance — fine */
    }
  }
  return parts.join("\n");
}

const MAX_REPORT_CHARS = 4000;
const LATEST_REPORTS = 3;

/**
 * Operational context beyond the bundle: the freshest spoke reports and any
 * pending approvals — what a coordinating hub (and any spoke) should see.
 * Read-only context; still L1-safe.
 */
function instanceContext(instance: ResolvedInstance): string {
  const parts: string[] = [];
  try {
    const files = readdirSync(instance.reportsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .slice(-LATEST_REPORTS);
    if (files.length > 0) {
      parts.push("\n## Latest reports from the mesh");
      for (const f of files) {
        const raw = readFileSync(path.join(instance.reportsDir, f), "utf8");
        const clipped = raw.length > MAX_REPORT_CHARS ? raw.slice(0, MAX_REPORT_CHARS) + "\n…(truncated)" : raw;
        parts.push(`\n### reports/${f}\n\n${clipped}`);
      }
    }
  } catch {
    /* no reports dir yet */
  }
  try {
    const store = new ApprovalStore(instance.approvalsDir);
    const pending = store.list("pending");
    if (pending.length > 0) {
      parts.push("\n## Pending approvals (awaiting the principal)");
      for (const p of pending) parts.push(`- ${p.id}: ${p.actionType} — ${p.summary} (requested by ${p.requestedBy})`);
    }
  } catch {
    /* no approvals dir yet */
  }
  return parts.join("\n");
}
