import { findAgent, assertActivatable, effectiveCognition, type AgentConcept } from "../agents/concept.js";
import { loadGatedTypes, assertActionAllowed } from "../gates/gatekeeper.js";
import { resolveProvider, type AgentWorkerProvider, type ApiProviderContext } from "../providers/index.js";
import type { InstanceStore } from "../instance/store.js";
import type { InstanceConfig } from "../instance/config-core.js";
import { sourceSections } from "../sources/registry.js";
import {
  verifyConformanceBundle,
  verifyExpectedOutputsStore,
  verifyGateAssertionsStore,
  verifyLedgerCompletenessStore,
  allOk,
  type VerifierResult,
} from "./verifiers-core.js";

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
 * Workers-safe core: all instance I/O goes through the InstanceStore seam;
 * the store is REQUIRED here. The filesystem-default convenience wrapper
 * (and Node provider registration) lives in run.ts.
 */
export interface RunCoreOptions {
  /** The storage seam — a local directory or a git host over HTTPS. */
  store: InstanceStore;
  agentName: string;
  /** Test seam: inject a provider (e.g. FakeProvider) instead of resolving the concept's harness. */
  provider?: AgentWorkerProvider;
  /**
   * Env/fetch context for API providers (Worker secrets in the cloud).
   * Defaults to the store's instance env (.env/.env.local on fs stores).
   */
  providerCtx?: ApiProviderContext;
  /**
   * "per-run" (default): flush the store after verifiers — a no-op on fs.
   * "caller": the caller batches several runs into one flush (cloud beat).
   */
  flushPolicy?: "per-run" | "caller";
  /**
   * IANA timezone for the report datestamp. Default: the runtime's local
   * date. Workers run in UTC and MUST pass the instance timezone, or briefs
   * date-drift after 8 PM local (the 2026-07-06 datestamp lesson, ported).
   */
  timeZone?: string;
  runId?: string;
  now?: Date;
  onProgress?: (note: string) => void;
}

/** yyyy-mm-dd of an instant — in an IANA timezone when given, else runtime-local. */
export function dateStampFor(now: Date, timeZone?: string): string {
  if (timeZone) {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  }
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
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

export async function runAgentCore(options: RunCoreOptions): Promise<RunReport> {
  const store = options.store;
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
  const dateStamp = dateStampFor(now, options.timeZone);

  await store.appendLedger({ ts: startedAt, runId, agent: agent.name, action: "run-started", type: "report" });

  const providerCtx = options.providerCtx ?? { env: store.instanceEnv?.() ?? {} };
  const prompt = await buildPrompt(agent, store, config, dateStamp, providerCtx, progress);
  const cognition = effectiveCognition(agent, config);
  const provider = options.provider ?? resolveProvider(cognition.harness, providerCtx);
  provider.assertConfigured();
  progress(`run ${runId.slice(0, 8)}: ${agent.name} via ${provider.name} (${cognition.model})`);

  // The bundle IS the agent's working world: relative reads in any harness
  // resolve against the knowledge layer, matching the prompt's paths.
  // Remote stores have no local dir; API providers ignore cwd entirely.
  const result = await provider.run({
    prompt,
    cwd: store.bundleDir ?? (typeof process !== "undefined" ? process.cwd() : "/"),
    model: cognition.model,
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
    `model: ${cognition.model}`,
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
    model: cognition.model,
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
  providerCtx?: ApiProviderContext,
  log?: (note: string) => void,
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
  // Declared read sources (agent frontmatter opt-in) — live external context
  // inlined so L1 runs still need no tool access. Failures become honest
  // sections, never aborted runs.
  const external =
    agent.sources.length > 0
      ? await sourceSections(agent.sources, { env: providerCtx?.env ?? {}, fetchImpl: providerCtx?.fetchImpl, log })
      : [];
  return [
    sections.join("\n"),
    await bundleContext(store, config),
    await instanceContext(store),
    ...external,
    "\n## Output\nReturn ONLY the markdown body of your report (no code fences around the whole thing).",
  ].join("\n");
}

export function levelMeaning(level: string): string {
  switch (level) {
    case "L1": return "report-only";
    case "L2": return "draft-for-approval";
    case "L3": return "whitelisted reversible actions";
    case "L4": return "external actions, each behind a human gate";
    default: return "unknown";
  }
}

export async function bundleContext(store: InstanceStore, config: InstanceConfig): Promise<string> {
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
export async function instanceContext(store: InstanceStore): Promise<string> {
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
