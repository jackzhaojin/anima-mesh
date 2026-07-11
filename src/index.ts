/**
 * AnimaMesh — public engine API.
 *
 * The brain is private; AnimaMesh is what animates it. This engine consumes
 * any OKF bundle supplied by configuration and never references a particular
 * instance.
 */
export { parseConcept, serializeConcept, type Frontmatter, type ParsedConcept } from "./okf/frontmatter.js";
export { loadBundle, getConcept, conceptsByType, type Bundle, type Concept } from "./okf/bundle.js";
export {
  checkConformance,
  formatReport,
  type ConformanceProfile,
  type ConformanceReport,
  type ConformanceIssue,
} from "./okf/conformance.js";

export { Ledger, assertRunLogged, type LedgerEntry } from "./ledger/ledger.js";
export { ApprovalStore, type ApprovalRecord, type ApprovalStatus } from "./gates/approvals.js";
export {
  GateViolation,
  assertActionAllowed,
  loadGatedTypes,
  DEFAULT_GATED_TYPES,
  type ActionCheck,
} from "./gates/gatekeeper.js";
export { canPerform, parseLevel, requiresGate, LEVELS, type Level, type ActionCategory } from "./autonomy/ladder.js";

export {
  agentFromConcept,
  agentsFromBundle,
  findAgent,
  assertActivatable,
  ActivationGateError,
  type AgentConcept,
} from "./agents/concept.js";
export { loadInstance, CONFIG_FILENAME, DEFAULT_CONFIG, type InstanceConfig, type ResolvedInstance } from "./instance/config.js";

export {
  resolveProvider,
  registerProvider,
  FakeProvider,
  claudeCodeProvider,
  opencodeProvider,
  moonshotApiProvider,
  createMoonshotApiProvider,
  claudeAgentSdkProvider,
  createClaudeAgentSdkProvider,
  CLOUD_HARNESSES,
  type ApiProviderContext,
  type AgentWorkerProvider,
  type ProviderRunOptions,
  type ProviderResult,
} from "./providers/index.js";

export { runAgent, type RunOptions, type RunReport } from "./harness/run.js";
export {
  verifyConformance,
  verifyExpectedOutputs,
  verifyGateAssertions,
  verifyLedgerCompleteness,
  allOk,
  formatResults,
  type VerifierResult,
} from "./harness/verifiers.js";

export {
  resolveChannel,
  registerChannel,
  deliverLatestReport,
  consoleChannel,
  discordChannel,
  notionChannel,
  gmailChannel,
  type DeliveryChannel,
  type DeliveryMessage,
  type DeliveryResult,
  type ChannelContext,
} from "./channels/index.js";
export { heartbeat, PERIOD_HOURS, type HeartbeatOptions, type HeartbeatResult } from "./harness/heartbeat.js";
export { buildAgentCard, type AgentCard, type AgentCardSkill } from "./a2a/card.js";
export { loadInstanceEnv, getEnv } from "./instance/env.js";

export { scaffoldBrain, type InitAnswers, type ScaffoldResult } from "./init/scaffold.js";
export { loadAnswersFile, normalizeAnswers, interactiveInterview, agenticEnrich } from "./init/interview.js";
export { listAgentTemplates, loadAgentTemplate, fillTemplate, templatesDir } from "./init/templates.js";
