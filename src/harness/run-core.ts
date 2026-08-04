import { findAgent, agentsFromBundle, assertActivatable, effectiveCognition, type AgentConcept } from "../agents/concept.js";
import { loadGatedTypes, assertActionAllowed, GateViolation } from "../gates/gatekeeper.js";
import { parseScheduleRequest, mutateSchedule } from "./schedule.js";
import { applyDraftRequests, draftCapabilityLines } from "./drafts.js";
import { applyDefectReports } from "./defects.js";
import { parseReadRequests, serveReadRequests, stripReadRequests, readRequestCapabilityLines } from "./read-requests.js";
import { defectCapabilityLines } from "../defects/report-core.js";
import {
  resolveProvider,
  providerCapabilities,
  type AgentWorkerProvider,
  type ApiProviderContext,
  type ProviderCapabilities,
} from "../providers/index.js";
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
  /**
   * Lines from the triggering beat, appended to the prompt as their own
   * section (e.g. the cloud scheduler's "these DUE agents could not run on
   * this tier — surface it"). The hub's brief is the only surface the
   * principal reads; a scheduler fact that never reaches a prompt
   * effectively never happened.
   */
  beatNotes?: string[];
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
  // Provider FIRST, prompt second: what the harness can actually do is an
  // input to the prompt, not an afterthought. Assembling context before
  // knowing the runtime is how agents came to be told about tools they did
  // not have (issue #4). Resolving first also fails an unconfigured harness
  // before any live source fetch is spent.
  const cognition = effectiveCognition(agent, config);
  const provider = options.provider ?? resolveProvider(cognition.harness, providerCtx);
  provider.assertConfigured();
  const capabilities = providerCapabilities(provider);
  const webBudget = capabilities.webSearch ? agent.web : 0;
  const prompt = await buildPrompt(
    agent,
    store,
    config,
    dateStamp,
    { provider: provider.name, capabilities, webBudget },
    providerCtx,
    progress,
    options.sourceFs,
    options.beatNotes,
  );
  progress(`run ${runId.slice(0, 8)}: ${agent.name} via ${provider.name} (${cognition.model})`);

  // The bundle IS the agent's working world: relative reads in any harness
  // resolve against the knowledge layer, matching the prompt's paths.
  // Remote stores have no local dir; API providers ignore cwd entirely.
  const runOnce = (p: string) =>
    provider.run({
      prompt: p,
      cwd: store.bundleDir ?? (typeof process !== "undefined" ? process.cwd() : "/"),
      model: cognition.model,
      onProgress: progress,
      ...(webBudget > 0 ? { webSearchMaxUses: webBudget } : {}),
    });
  let result = await runOnce(prompt);
  // A capability the run asked for and did not get is operational evidence,
  // not a footnote — it belongs in the ledger next to the run that produced
  // the thinner report.
  if (result.degraded) {
    progress(`run ${runId.slice(0, 8)}: DEGRADED — ${result.degraded}`);
  }
  const runTokens = [normalizeTokens(result.tokens)];

  // Ask-driven retrieval (v0.17.0): a read-request in the output is model
  // judgment naming the files THIS run is about — the inline heuristics
  // can't know that. Code validates, serves, ledgers, and runs the agent
  // once more with the served section appended. ONE round: requests in the
  // continuation's own output are stripped, never served.
  const readRequests = parseReadRequests(result.text);
  if (readRequests.length > 0) {
    const served = await serveReadRequests({
      requests: readRequests,
      agent,
      store,
      config,
      sourceCtx: { env: providerCtx.env ?? {}, fetchImpl: providerCtx.fetchImpl, log: progress, sourceFs: options.sourceFs },
    });
    await store.appendLedger({
      ts: clock(),
      runId,
      agent: agent.name,
      action: "reads-requested",
      type: "report",
      detail: { requested: served.requested, served: served.served, refused: served.refused, chars: served.chars },
    });
    progress(`run ${runId.slice(0, 8)}: ${served.served}/${served.requested} requested read(s) served — continuation run`);
    result = await runOnce(`${prompt}\n${served.section}`);
    if (result.degraded) {
      progress(`run ${runId.slice(0, 8)}: DEGRADED — ${result.degraded}`);
    }
    runTokens.push(normalizeTokens(result.tokens));
  }
  const finalText = stripReadRequests(result.text);

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
    finalText,
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
  // A retrieval continuation is a second full model call — its spend belongs
  // to this run's total, not just the last call's.
  const tokens = runTokens.reduce<TokenCounts | undefined>((acc, t) => {
    if (!t) return acc;
    if (!acc) return { ...t };
    return { input: (acc.input ?? 0) + (t.input ?? 0), output: (acc.output ?? 0) + (t.output ?? 0) };
  }, undefined);
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
    text: finalText,
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
  runtime: { provider: string; capabilities: ProviderCapabilities; webBudget: number },
  providerCtx?: ApiProviderContext,
  log?: (note: string) => void,
  sourceFs?: SourceFs,
  beatNotes?: string[],
): Promise<string> {
  const sections: string[] = [];
  sections.push(
    `You are "${agent.title}" (${agent.name}), an agent in an AnimaMesh company-of-0 mesh.`,
    `Today is ${dateStamp}. Autonomy level: ${agent.level} (${levelMeaning(agent.level)}).`,
    "",
    "## Your job",
    agent.job,
    "",
    ...capabilityLines(agent, runtime),
    "",
    "## Operating rules",
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
  // Ask-driven retrieval (v0.17.0): every agent may request specific files —
  // the inline heuristics can't know what THIS run is about; the model can.
  sections.push(...readRequestCapabilityLines(agent));
  // Beat notes come from the deterministic scheduler, not the model — they
  // outrank recall the same way capability lines do.
  if (beatNotes && beatNotes.length > 0) {
    sections.push("", ...beatNotes);
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
    await declaredReadsContext(store, config, agent),
    await instanceContext(store),
    ...external,
    "\n## Output\nReturn ONLY the markdown body of your report (no code fences around the whole thing).",
  ].join("\n");
}

/**
 * The capability contract, stated to the agent in its own prompt.
 *
 * This exists because of engine issue #4: research-watch's job said "budget
 * ~8 web fetches per heartbeat" while its cloud harness sent no tools at all.
 * The model had no way to distinguish "I have no web tool" from "the web tool
 * returned nothing", so two consecutive runs reported a *tool failure* that
 * had never been a tool — and unchecked subjects came within one sentence of
 * being read as unchanged.
 *
 * So: say what the runtime grants, say it AFTER the job description, and say
 * that it wins. A job description is written once; capabilities change with
 * every harness swap and override.
 */
export function capabilityLines(
  agent: AgentConcept,
  runtime: { provider: string; capabilities: ProviderCapabilities; webBudget: number },
): string[] {
  const { capabilities: caps, provider } = runtime;
  const lines = [
    "## Your capabilities this run",
    `Harness: \`${provider}\`. These are the FACTS about what you can do right now, and they`,
    "override anything your job description implies. Never describe a check you could not run as",
    "a check that found nothing — an unrun check is a gap, and gaps get reported.",
    "",
  ];

  if (caps.fileReads) {
    lines.push(
      "- **File reads: YES.** Your working directory is the bundle root — paths like `ops/calendar.md`",
      "  and `facts/*.md` resolve directly, beyond the excerpts inlined below.",
    );
  } else {
    lines.push(
      "- **File reads: NO.** You have no filesystem access and cannot open paths. Everything you can",
      "  know about this instance is inlined below; a file you were not given is a file you cannot read.",
    );
  }

  if (runtime.webBudget > 0) {
    lines.push(
      `- **Web search: YES**, up to ${runtime.webBudget} searches this run. Spend them on the checks that`,
      "  most need live confirmation, and cite what you found. Unspent budget is not a virtue; an",
      "  unsupported claim is still an unsupported claim.",
    );
  } else if (agent.web > 0) {
    // Declared but unavailable — the exact shape that silently failed before.
    lines.push(
      `- **Web search: NO — and your concept asks for ${agent.web}.** This harness (\`${provider}\`) cannot`,
      "  search the web, so no external check can run this cycle. Do NOT attempt fetches and do NOT",
      "  report the result as an empty or failed lookup: report plainly that the capability is absent,",
      "  name which checks went unrun, and continue with the work you CAN do from the context below.",
    );
  } else {
    lines.push(
      "- **Web search: NO.** You cannot browse, search, or fetch URLs. Anything you would need to look",
      "  up externally is out of reach this run — say so rather than reasoning from stale recall.",
    );
  }

  lines.push(
    "- **Other tools: NONE.** You run no commands and cause no side effects. Your only output is the",
    "  report body; the harness writes it.",
    agent.sources.length > 0
      ? `- **External context: the source sections below (${agent.sources.join(", ")})** — read them as this run's live listing, and nothing beyond them.`
      : "- **External context: none declared** beyond the bundle excerpts below.",
  );
  if (agent.reads.length > 0) {
    lines.push(
      `- **Declared reads: ${agent.reads.length} path(s)** from your concept's \`reads:\` frontmatter, inlined in the`,
      '  "Role-declared context" section below. Every declared path appears there — content, an EMPTY',
      "  marker, or a NOT AVAILABLE marker — never silently dropped.",
    );
  }
  return lines;
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

const RECENT_EVENTS = 5;
const MAX_EVENT_CHARS = 3000;

export async function bundleContext(store: InstanceStore, config: InstanceConfig): Promise<string> {
  // Tolerant reads — a missing ops file is context absence, not a crash.
  const parts: string[] = ["\n## Bundle context (source of truth excerpts)"];
  // ops/nags.md: the persistent-reminder surface — principals opt in to being
  // bugged every heartbeat until an item is done. Inlined for EVERY agent.
  for (const rel of ["index.md", "ops/calendar.md", "ops/watch-list.md", "ops/nags.md"]) {
    const raw = await store.readOptional(`${config.bundle}/${rel}`);
    if (raw !== null) parts.push(`\n### ${rel}\n\n${raw}`);
  }
  // events/: the bundle's append-only "what changed" stream. Conventions route
  // every correction and settled fact through an event — but no harness surface
  // carried them, so on a no-tool harness a fresh event was invisible and
  // agents re-derived questions the principal had already settled. The newest
  // few are ambient context for every agent, every run; date-prefixed names
  // make lexicographic order chronological.
  const events = await store.listFiles(`${config.bundle}/events`);
  if (events.length > 0) {
    const recent = events.slice(-RECENT_EVENTS).reverse();
    parts.push(
      `\n### Recent events (${recent.length} of ${events.length}, newest first — the full stream stays in events/)`,
      "Treat these as settled: an event supersedes older reports, watch items, and your own recall.",
    );
    for (const name of recent) {
      const raw = (await store.readOptional(`${config.bundle}/events/${name}`)) ?? "";
      const clipped =
        raw.length > MAX_EVENT_CHARS ? raw.slice(0, MAX_EVENT_CHARS) + "\n…(truncated by the harness)" : raw;
      parts.push(`\n#### events/${name}\n\n${raw.trim() ? clipped : "(file exists and is EMPTY)"}`);
    }
  }
  return parts.join("\n");
}

const MAX_READ_CHARS = 6000;
const MAX_DIR_FILES = 20;

/**
 * Role-declared required reading (issue #5). An agent's job prose used to
 * name paths as "read these every run" — and on a no-tool harness the
 * assembled context simply lacked them: no placeholder, no signal,
 * indistinguishable from the paths not existing. The chief-of-staff only
 * caught it by diffing its own role text against what it was given.
 *
 * The contract now: every path in frontmatter `reads:` produces a section
 * below — content, an explicit EMPTY marker, or an explicit NOT-AVAILABLE
 * marker. "Nothing to report" and "wasn't given the data" are different
 * facts, and the prompt keeps them distinguishable. Paths resolve
 * bundle-relative first (the job prose speaks bundle paths), then
 * instance-root-relative (drafts live beside the bundle, not in it).
 */
export async function declaredReadsContext(
  store: InstanceStore,
  config: InstanceConfig,
  agent: AgentConcept,
): Promise<string> {
  if (agent.reads.length === 0) return "";
  const parts: string[] = [
    "\n## Role-declared context (your `reads:` paths, inlined by the harness)",
    "Every path your concept declares appears below — as content, an explicit EMPTY marker, or an",
    "explicit NOT AVAILABLE marker. A path marked NOT AVAILABLE was not given to you this run:",
    'treat it as a data gap and say so; never let it read as "nothing to report".',
  ];
  const clip = (raw: string): string =>
    raw.length > MAX_READ_CHARS ? raw.slice(0, MAX_READ_CHARS) + "\n…(truncated by the harness)" : raw;

  for (const decl of agent.reads) {
    // Same jail as every declared surface: instance-relative, no escapes.
    if (decl.startsWith("/") || decl.split("/").includes("..")) {
      parts.push(`\n### ${decl} — INVALID PATH (absolute or escaping the instance); not read`);
      continue;
    }
    const rel = decl.replace(/\/+$/, "");
    const candidates = [`${config.bundle}/${rel}`, rel];

    let resolved = false;
    for (const candidate of candidates) {
      const raw = await store.readOptional(candidate);
      if (raw === null) continue;
      parts.push(`\n### ${decl}\n\n${raw.trim() ? clip(raw) : "(file exists and is EMPTY)"}`);
      resolved = true;
      break;
    }
    if (resolved) continue;

    for (const candidate of candidates) {
      const names = await store.listFiles(candidate);
      if (names.length === 0) continue;
      const shown = names.slice(0, MAX_DIR_FILES);
      parts.push(`\n### ${decl} (directory — ${names.length} file(s))`);
      for (const name of shown) {
        const raw = (await store.readOptional(`${candidate}/${name}`)) ?? "";
        parts.push(`\n#### ${decl.replace(/\/+$/, "")}/${name}\n\n${raw.trim() ? clip(raw) : "(file exists and is EMPTY)"}`);
      }
      if (names.length > shown.length) {
        // No silent caps: what was dropped is named, so the agent knows the
        // directory is larger than what it was shown.
        parts.push(`\n(${names.length - shown.length} more file(s) NOT inlined: ${names.slice(MAX_DIR_FILES).join(", ")})`);
      }
      resolved = true;
      break;
    }
    if (!resolved) {
      parts.push(`\n### ${decl} — DECLARED IN YOUR ROLE BUT NOT AVAILABLE THIS RUN (missing, empty directory, or unreadable)`);
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
