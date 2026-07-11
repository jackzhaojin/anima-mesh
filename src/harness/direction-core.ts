import { findAgent, assertActivatable } from "../agents/concept.js";
import { loadGatedTypes, assertActionAllowed } from "../gates/gatekeeper.js";
import { resolveProvider, type AgentWorkerProvider, type ApiProviderContext } from "../providers/index.js";
import type { InstanceStore } from "../instance/store.js";
import {
  dateStampFor,
  bundleContext,
  instanceContext,
  levelMeaning,
} from "./run-core.js";
import {
  verifyConformanceBundle,
  verifyExpectedOutputsStore,
  verifyGateAssertionsStore,
  verifyLedgerCompletenessStore,
  allOk,
  type VerifierResult,
} from "./verifiers-core.js";

/**
 * Direction — the mesh's second entry point beside the heartbeat. An inbound
 * message addressed to the persona (Discord interaction, polled email)
 * becomes ONE agentic run: the model reads the message with full bundle
 * context and decides the disposition itself — reply, recommend work, flag
 * for the principal, or say "nothing to do". No keyword routing anywhere.
 *
 * Safety identical to a beat run: L1 report-only, the artifact is written by
 * the harness, gates and verifiers unchanged. Two deliberate differences:
 *
 *  - Ledger actions are `direction-*`, NOT `run-*`: the heartbeat's daily
 *    dedup filters on `run-completed`, so a midday direction can never eat
 *    tomorrow's 08:00 brief (the same-day-rerun lesson, ported).
 *  - The artifact is `{date}-{agent}.direction-{runid}.md` — the DOT before
 *    "direction" keeps delivery's `-{agent}-` matcher blind to it, so a
 *    direction reply never gets re-delivered as "the latest brief".
 *
 * Sender allowlists and budget counting live at the channel edge (the
 * Worker, which owns the secrets and the day counter); this core trusts its
 * caller has gated the sender and only enforces judgment + evidence.
 */

export interface DirectionMessage {
  /** Where it came from: "discord", "gmail", "web", ... */
  channel: string;
  /** Channel-native sender id (Discord user id, email address). */
  sender: string;
  /** The message text the persona is asked to act on. */
  text: string;
  /** ISO timestamp of receipt. */
  receivedAt: string;
  /** Channel-native message id — dedup key for polled channels. */
  messageId?: string;
}

export interface DirectionRunOptions {
  store: InstanceStore;
  message: DirectionMessage;
  /** Override the config's direction agent (tests). */
  agentName?: string;
  /** Test seam: inject a provider instead of resolving the harness. */
  provider?: AgentWorkerProvider;
  providerCtx?: ApiProviderContext;
  /** "per-run" (default) flushes here; "caller" batches (the Worker). */
  flushPolicy?: "per-run" | "caller";
  timeZone?: string;
  runId?: string;
  now?: Date;
  onProgress?: (note: string) => void;
}

export interface DirectionRunReport {
  runId: string;
  agent: string;
  harness: string;
  model: string;
  /** The text to send back on the originating channel. */
  reply: string;
  reportPath: string;
  verifierResults: VerifierResult[];
  ok: boolean;
}

export const DIRECTION_ACTIONS = ["direction-started", "direction-report-written", "direction-completed"];

/** Max reply size — Discord caps content at 2000; email tolerates more but a direction reply is a note, not a memo. */
const REPLY_LIMIT = 1900;

export async function runDirectionCore(options: DirectionRunOptions): Promise<DirectionRunReport> {
  const store = options.store;
  const config = await store.loadConfig();
  const bundle = await store.loadBundle();
  const agentName =
    options.agentName ?? config.direction?.agent ?? config.delivery?.deliverAgent ?? "chief-of-staff";
  const agent = findAgent(bundle, agentName);
  const progress = options.onProgress ?? (() => {});
  const message = options.message;

  // Same gates as any run: D11 dual gate, ladder-level check before cognition.
  assertActivatable(agent, config);
  const gatedTypes = loadGatedTypes(bundle);
  const approvalRecords = new Map((await store.listApprovals()).map((r) => [r.id, r]));
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
  const clock = options.now ? () => startedAt : () => new Date().toISOString();
  const dateStamp = dateStampFor(now, options.timeZone);

  await store.appendLedger({
    ts: startedAt,
    runId,
    agent: agent.name,
    action: "direction-started",
    type: "report",
    detail: { channel: message.channel, sender: message.sender, messageId: message.messageId },
  });

  const prompt = await buildDirectionPrompt(agent, store, config, dateStamp, message);
  const providerCtx = options.providerCtx ?? { env: store.instanceEnv?.() ?? {} };
  const provider = options.provider ?? resolveProvider(agent.harness, providerCtx);
  provider.assertConfigured();
  progress(`direction ${runId.slice(0, 8)}: ${agent.name} via ${provider.name} (${message.channel})`);

  const result = await provider.run({
    prompt,
    cwd: store.bundleDir ?? (typeof process !== "undefined" ? process.cwd() : "/"),
    model: agent.model,
    onProgress: progress,
  });
  const reply = result.text.trim().slice(0, REPLY_LIMIT);

  // The artifact is the evidence: the inbound message AND the disposition,
  // written by the harness (L1 contract), named so brief delivery skips it.
  const reportName = `${dateStamp}-${agent.name}.direction-${runId.slice(0, 8)}.md`;
  const reportContent = [
    "---",
    "type: report",
    "trigger: direction",
    `agent: ${agent.name}`,
    `runId: ${runId}`,
    `date: ${dateStamp}`,
    `channel: ${message.channel}`,
    `sender: ${message.sender}`,
    `harness: ${provider.name}`,
    `model: ${agent.model}`,
    "---",
    "",
    "## Direction received",
    "",
    message.text.trim(),
    "",
    "## Disposition",
    "",
    reply,
    "",
  ].join("\n");
  await store.writeReport(reportName, reportContent);
  await store.appendLedger({
    ts: clock(),
    runId,
    agent: agent.name,
    action: "direction-report-written",
    type: "report",
    detail: { path: `${config.reports}/${reportName}` },
  });
  await store.appendLedger({
    ts: clock(),
    runId,
    agent: agent.name,
    action: "direction-completed",
    type: "report",
    detail: { channel: message.channel, replyChars: reply.length },
  });

  const verifierResults: VerifierResult[] = [
    verifyConformanceBundle(await store.loadBundle(), "animamesh"),
    await verifyExpectedOutputsStore(store, [reportName]),
    await verifyGateAssertionsStore(store, gatedTypes, runId),
    await verifyLedgerCompletenessStore(store, runId, DIRECTION_ACTIONS),
  ];

  if ((options.flushPolicy ?? "per-run") === "per-run") {
    await store.flush(`direction(${agent.name}): ${message.channel} ${runId.slice(0, 8)}`);
  }

  return {
    runId,
    agent: agent.name,
    harness: provider.name,
    model: agent.model,
    reply,
    reportPath: store.reportPath(reportName),
    verifierResults,
    ok: allOk(verifierResults),
  };
}

/**
 * The direction prompt: the persona's standing context (job, bundle,
 * latest mesh reports, pending approvals) plus the inbound message and the
 * disposition rules. The model decides what the message means and what to
 * do about it — within L1: words and recommendations, never side effects.
 */
async function buildDirectionPrompt(
  agent: ReturnType<typeof findAgent>,
  store: InstanceStore,
  config: Awaited<ReturnType<InstanceStore["loadConfig"]>>,
  dateStamp: string,
  message: DirectionMessage,
): Promise<string> {
  const preamble = [
    `You are "${agent.title}" (${agent.name}), an agent in an AnimaMesh company-of-0 mesh.`,
    `Today is ${dateStamp}. Autonomy level: ${agent.level} (${levelMeaning(agent.level)}).`,
    "",
    "## Your job",
    agent.job,
    "",
    "## Operating rules",
    "- Base every claim about stable facts on the bundle excerpts below — never on recall.",
    "- You are answering a direct message from your principal, not writing a scheduled report.",
    "- You cannot take actions directly: consequential work goes through the approval gate as usual.",
    "  If the direction asks for one, say what you would do and what approval it needs.",
    "- Decide the disposition yourself: answer, recommend, flag for a scheduled run, or say honestly",
    "  that nothing needs doing. Never invent work.",
    "- Reply in under 300 words — this goes back over chat/email, not into a filing.",
  ].join("\n");

  const directionSection = [
    "\n## Incoming direction",
    "",
    `- channel: ${message.channel}`,
    `- from: ${message.sender} (your principal — already authenticated by the channel edge)`,
    `- received: ${message.receivedAt}`,
    "",
    "```",
    message.text.trim(),
    "```",
  ].join("\n");

  return [
    preamble,
    await bundleContext(store, config),
    await instanceContext(store),
    directionSection,
    "\n## Output\nReturn ONLY your reply text as markdown (no code fences around the whole thing).",
  ].join("\n");
}
