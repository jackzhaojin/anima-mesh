import { findAgent, assertActivatable, type AgentConcept } from "../agents/concept.js";
import { loadGatedTypes, assertActionAllowed } from "../gates/gatekeeper.js";
import { resolveProvider, type AgentWorkerProvider, type ApiProviderContext } from "../providers/index.js";
import type { InstanceStore } from "../instance/store.js";
import { FsInstanceStore } from "../instance/store-fs.js";
import type { InstanceConfig } from "../instance/config.js";
import {
  verifyConformanceBundle,
  verifyExpectedOutputsStore,
  verifyGateAssertionsStore,
  verifyLedgerCompletenessStore,
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
 *
 * All instance I/O goes through the InstanceStore seam — the same run works
 * against a local directory (FsInstanceStore) or a git host over HTTPS.
 */
export interface RunOptions {
  /** Filesystem instance root; ignored when `store` is provided. */
  instanceRoot?: string;
  /** The storage seam. Default: FsInstanceStore(instanceRoot). */
  store?: InstanceStore;
  agentName: string;
  /** Test seam: inject a provider (e.g. FakeProvider) instead of resolving the concept's harness. */
  provider?: AgentWorkerProvider;
  /**
   * Env/fetch context for API providers (Worker secrets in the cloud).
   * Defaults to the instance's .env/.env.local — laptop runs pick up keys
   * like MOONSHOT_API_KEY without any process-level export.
   */
  providerCtx?: ApiProviderContext;
  /**
   * "per-run" (default): flush the store after verifiers — a no-op on fs.
   * "caller": the caller batches several runs into one flush (cloud beat).
   */
  flushPolicy?: "per-run" | "caller";
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

function resolveStore(options: { instanceRoot?: string; store?: InstanceStore }): InstanceStore {
  if (options.store) return options.store;
  if (!options.instanceRoot) throw new Error("runAgent: provide `store` or `instanceRoot`");
  return new FsInstanceStore(options.instanceRoot);
}

export async function runAgent(options: RunOptions): Promise<RunReport> {
  const store = resolveStore(options);
  const config = await store.loadConfig();
  const bundle = await store.loadBundle();
  const agent = findAgent(bundle, options.agentName);
  const progress = options.onProgress ?? (() => {});

  // D11 dual gate — commercial capability never runs without permission.
  assertActivatable(agent, config);

  const gatedTypes = loadGatedTypes(bundle);
  const approvalRecords = new Map((await store.listApprovals()).map((r) => [r.id, r]));

  // The run's artifact category must be within the agent's ladder level —
  // checked in code before any model is invoked.
  assertActionAllowed({
    agent: agent.name,
    level: agent.level,
    category: "report",
    actionType: "report",
    gatedTypes,
    approvals: { get: (id) => approvalRecords.get(id) },
  });

  const runId = options.runId ?? crypto.randomUUID();
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

  await store.appendLedger({ ts: startedAt, runId, agent: agent.name, action: "run-started", type: "report" });

  const prompt = await buildPrompt(agent, store, config, dateStamp);
  const providerCtx = options.providerCtx ?? { env: store.instanceEnv?.() ?? {} };
  const provider = options.provider ?? resolveProvider(agent.harness, providerCtx);
  provider.assertConfigured();
  progress(`run ${runId.slice(0, 8)}: ${agent.name} via ${provider.name} (${agent.model})`);

  // The bundle IS the agent's working world: relative reads in any harness
  // resolve against the knowledge layer, matching the prompt's paths.
  // Remote stores have no local dir; API providers ignore cwd entirely.
  const result = await provider.run({
    prompt,
    cwd: store.bundleDir ?? (typeof process !== "undefined" ? process.cwd() : "/"),
    model: agent.model,
    onProgress: progress,
  });

  // L1 contract: the harness, not the agent, writes the artifact.
  const reportName = `${dateStamp}-${agent.name}-${runId.slice(0, 8)}.md`;
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
  await store.writeReport(reportName, reportContent);
  await store.appendLedger({
    ts: clock(),
    runId,
    agent: agent.name,
    action: "report-written",
    type: "report",
    detail: { path: `${config.reports}/${reportName}` },
  });

  const finishedAt = clock();
  await store.appendLedger({ ts: finishedAt, runId, agent: agent.name, action: "run-completed", type: "report" });

  const verifierResults: VerifierResult[] = [
    verifyConformanceBundle(await store.loadBundle(), "animamesh"),
    await verifyExpectedOutputsStore(store, [reportName]),
    await verifyGateAssertionsStore(store, gatedTypes, runId),
    await verifyLedgerCompletenessStore(store, runId, DECLARED_ACTIONS),
  ];

  if ((options.flushPolicy ?? "per-run") === "per-run") {
    await store.flush(`beat(${agent.name}): run ${runId.slice(0, 8)}`);
  }

  return {
    runId,
    agent: agent.name,
    harness: provider.name,
    model: agent.model,
    startedAt,
    finishedAt,
    reportPath: store.reportPath(reportName),
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
async function buildPrompt(
  agent: AgentConcept,
  store: InstanceStore,
  config: InstanceConfig,
  dateStamp: string,
): Promise<string> {
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
    await bundleContext(store, config),
    await instanceContext(store),
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

async function bundleContext(store: InstanceStore, config: InstanceConfig): Promise<string> {
  // Tolerant reads — a missing ops file is context absence, not a crash.
  const parts: string[] = ["\n## Bundle context (source of truth excerpts)"];
  // ops/nags.md: the persistent-reminder surface — principals opt in to being
  // bugged every heartbeat until an item is done. Inlined for EVERY agent.
  for (const rel of ["index.md", "ops/calendar.md", "ops/watch-list.md", "ops/nags.md"]) {
    const raw = await store.readOptional(`${config.bundle}/${rel}`);
    if (raw !== null) parts.push(`\n### ${rel}\n\n${raw}`);
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
async function instanceContext(store: InstanceStore): Promise<string> {
  const parts: string[] = [];
  const files = (await store.listReports()).slice(-LATEST_REPORTS);
  if (files.length > 0) {
    parts.push("\n## Latest reports from the mesh");
    for (const f of files) {
      try {
        const raw = await store.readReport(f);
        const clipped = raw.length > MAX_REPORT_CHARS ? raw.slice(0, MAX_REPORT_CHARS) + "\n…(truncated)" : raw;
        parts.push(`\n### reports/${f}\n\n${clipped}`);
      } catch {
        /* report listed but unreadable — treat as absent */
      }
    }
  }
  const pending = await store.listApprovals("pending");
  if (pending.length > 0) {
    parts.push("\n## Pending approvals (awaiting the principal)");
    for (const p of pending) parts.push(`- ${p.id}: ${p.actionType} — ${p.summary} (requested by ${p.requestedBy})`);
  }
  return parts.join("\n");
}
