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
  registerContextualFactory,
  FakeProvider,
  moonshotApiProvider,
  createMoonshotApiProvider,
  CLOUD_HARNESSES,
  type ApiProviderContext,
  type AgentWorkerProvider,
  type ProviderRunOptions,
  type ProviderResult,
} from "./providers/index.js";
export {
  claudeCodeProvider,
  opencodeProvider,
  claudeAgentSdkProvider,
  createClaudeAgentSdkProvider,
} from "./providers/node-providers.js";

export { type InstanceStore } from "./instance/store.js";
export { FsInstanceStore } from "./instance/store-fs.js";
export { GitHubInstanceStore, type GitHubStoreOptions } from "./instance/store-github.js";
export { githubToken } from "./instance/github-auth.js";
export { runAgent, type RunOptions, type RunReport } from "./harness/run.js";
export {
  verifyConformance,
  verifyConformanceBundle,
  verifyExpectedOutputs,
  verifyExpectedOutputsStore,
  verifyGateAssertions,
  verifyGateAssertionsStore,
  verifyGateEntries,
  verifyLedgerCompleteness,
  verifyLedgerCompletenessStore,
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

export {
  composeLocalAgents,
  composeInteractiveBody,
  selectLocalAgents,
  localAgentSlug,
  localHubName,
  opencodeModelFor,
  type LocalAgentArtifact,
  type LocalAgentSelection,
} from "./local/agents-core.js";
export { exportLocalAgents, type ExportLocalResult } from "./local/agents.js";
export {
  parseDefectReports,
  stripDefectReports,
  defectCapabilityLines,
  identityLeakGuard,
  engineRepoSlug,
  createDefectIssue,
  defectDraftSlug,
  defectDraftContent,
  MAX_DEFECTS_PER_RUN,
  type DefectReport,
  type DefectIssueResult,
  type DefectDraftFields,
} from "./defects/report-core.js";
export { applyDefectReports, type ApplyDefectsOptions } from "./harness/defects.js";
export {
  listDefectDrafts,
  fileDefectDrafts,
  type DefectDraft,
  type FileDefectsOptions,
  type FileDefectsResult,
} from "./defects/file.js";

export { scaffoldBrain, type InitAnswers, type ScaffoldResult } from "./init/scaffold.js";
export { loadAnswersFile, normalizeAnswers, interactiveInterview, agenticEnrich } from "./init/interview.js";
export { listAgentTemplates, loadAgentTemplate, fillTemplate, templatesDir } from "./init/templates.js";
