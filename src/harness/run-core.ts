import { findAgent, agentsFromBundle, assertActivatable, effectiveCognition, type AgentConcept } from "../agents/concept.js";
import { loadGatedTypes, assertActionAllowed, GateViolation } from "../gates/gatekeeper.js";
import { parseScheduleRequest, mutateSchedule } from "./schedule.js";
import { applyDraftRequests, draftCapabilityLines } from "./drafts.js";
import { applyDefectReports } from "./defects.js";
import { defectCapabilityLines } from "../defects/report-core.js";
import { resolveProvider, type AgentWorkerProvider, type ApiProviderContext } from "../providers/index.js";
import type { InstanceStore } from "../instance/store.js";
import type { InstanceConfig } from "../instance/config-core.js";
import { sourceSections } from "../sources/registry.js";
import type { SourceFs } from "../sources/types.js";
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
   * Local-read capability for sources — injected by the Node wrappers
   * (run.ts / heartbeat.ts); Workers leave it unset so sources fall back to
   * their fetch-based access paths.
   */
  sourceFs?: SourceFs;
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
  /** Normalized provider usage — spend observability for an always-on mesh. */
  tokens?: TokenCounts;
}

export interface TokenCounts {
  input?: number;
  output?: number;
}

/**
 * Providers return vendor-shaped usage (`prompt_tokens`/`completion_tokens`
 * or `input_tokens`/`output_tokens`); normalize to one shape or nothing.
 */
export function normalizeTokens(tokens: unknown): TokenCounts | undefined {
  if (!tokens || typeof tokens !== "object") return undefined;
  const t = tokens as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const input = num(t.input_tokens) ?? num(t.prompt_tokens);
  const output = num(t.output_tokens) ?? num(t.completion_tokens);
  return input === undefined && output === undefined ? undefined : { input, output };
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
  const prompt = await buildPrompt(agent, store, config, dateStamp, providerCtx, progress, options.sourceFs);
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
  const tokens = normalizeTokens(result.tokens);
  await store.appendLedger({
    ts: finishedAt,
    runId,
    agent: agent.name,
    action: "run-completed",
    type: "report",
    ...(tokens ? { detail: { tokens } } : {}),
  });

  // A `schedule-request` block in the output is model judgment ASKING for a
  // schedule edit; whether it applies is decided here, in code, by the same
  // gate that governs every reversible action (level + whitelist). Model
  // proposes, deterministic code disposes. A denied request is ledgered and
  // stays visible in the report — never silently dropped, never a throw.
  const requestedWake = parseScheduleRequest(result.text);
  if (requestedWake && requestedWake.length > 0) {
    const roster = new Set(agentsFromBundle(bundle).map((a) => a.name));
    // Self-wakes are dropped: an agent that wakes itself daily is a loop.
    const valid = requestedWake.filter((n) => roster.has(n) && n !== agent.name);
    const dropped = requestedWake.filter((n) => !roster.has(n) || n === agent.name);
    try {
      assertActionAllowed({
        agent: agent.name,
        level: agent.level,
        category: "reversible",
        actionType: "schedule-update",
        gatedTypes,
        approvals: { get: (id) => approvalRecords.get(id) },
        whitelist: agent.whitelist,
      });
      if (valid.length > 0) {
        await mutateSchedule(store, config, (s) => ({ ...s, wake: [...new Set([...s.wake, ...valid])] }));
        await store.appendLedger({
          ts: clock(),
          runId,
          agent: agent.name,
          action: "schedule-updated",
          type: "schedule-update",
          detail: { wake: valid, ...(dropped.length > 0 ? { dropped } : {}) },
        });
        progress(`run ${runId.slice(0, 8)}: schedule-update applied — wake [${valid.join(", ")}]`);
      }
    } catch (err) {
      if (!(err instanceof GateViolation)) throw err;
      await store.appendLedger({
        ts: clock(),
        runId,
        agent: agent.name,
        action: "schedule-request-denied",
        type: "schedule-update",
        detail: { requested: requestedWake, reason: err.message },
      });
      progress(`run ${runId.slice(0, 8)}: schedule-request denied — ${err.message}`);
    }
  }

  // `draft-request` blocks: the same propose/dispose contract, generalized to
  // artifacts under the drafts dir (see drafts.ts for the jail + caps).
  await applyDraftRequests({
    store,
    config,
    agent,
    runId,
    gatedTypes,
    approvals: approvalRecords,
    clock,
    text: result.text,
    progress,
  });

  // `defect-report` blocks: engine-feedback issues on the public engine repo
  // (see defects/report-core.ts for the leak guard + dedup).
  await applyDefectReports({
    store,
    config,
    agent,
    runId,
    gatedTypes,
    approvals: approvalRecords,
    clock,
    text: result.text,
    progress,
    env: providerCtx.env ?? {},
    fetchImpl: providerCtx.fetchImpl,
  });

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
    tokens,
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
  sourceFs?: SourceFs,
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
  // Only agents whose whitelist actually permits schedule-update are told
  // about it — offering a capability the gate would deny invites noise.
  if (agent.whitelist.includes("schedule-update")) {
    sections.push(
      "- You may schedule other agents to run at the NEXT heartbeat when follow-up work should not wait",
      "  for their own cadence. End your report with exactly this fenced block (agent names only):",
      "  ```schedule-request",
      "  wake: [agent-name, other-agent]",
      "  ```",
      "  The harness applies it through your whitelist gate and records it in the ledger. Woken agents",
      "  see the latest reports when they run — write the ask into your report so they know why.",
    );
  }
  if (agent.whitelist.includes("draft-write")) {
    sections.push(...draftCapabilityLines(config.drafts));
  }
  if (agent.whitelist.includes("defect-report")) {
    sections.push(...defectCapabilityLines(config.drafts));
  }
  // Declared read sources (agent frontmatter opt-in) — live external context
  // inlined so L1 runs still need no tool access. Failures become honest
  // sections, never aborted runs.
  const external =
    agent.sources.length > 0
      ? await sourceSections(agent.sources, { env: providerCtx?.env ?? {}, fetchImpl: providerCtx?.fetchImpl, log, sourceFs })
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
