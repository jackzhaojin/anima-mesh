import type { Bundle, Concept } from "../okf/bundle-core.js";
import { conceptsByType } from "../okf/bundle-core.js";
import { parseLevel, type Level } from "../autonomy/ladder.js";
import type { InstanceConfig } from "../instance/config-core.js";

/**
 * An agent IS its concept file (D6/D14): level, model, and harness live in
 * the knowledge layer, with the job description as the body. Promotions and
 * model swaps are config edits with git history — never rebuilds.
 */
export interface AgentConcept {
  name: string;
  title: string;
  level: Level;
  model: string;
  harness: string;
  heartbeat?: string;
  whitelist: string[];
  commercial: boolean;
  /** The job description — handed to the provider as the core of the prompt. */
  job: string;
  relPath: string;
}

export function agentFromConcept(concept: Concept): AgentConcept {
  const fm = concept.frontmatter;
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name : concept.relPath.replace(/^.*\//, "").replace(/\.md$/, "");
  const model = fm.model;
  const harness = fm.harness;
  if (typeof model !== "string" || !model.trim()) throw new Error(`agent ${name}: missing model (D14 chokepoint)`);
  if (typeof harness !== "string" || !harness.trim()) throw new Error(`agent ${name}: missing harness (D14 chokepoint)`);
  return {
    name,
    title: typeof fm.title === "string" ? fm.title : name,
    level: parseLevel(fm.level),
    model,
    harness,
    heartbeat: typeof fm.heartbeat === "string" ? fm.heartbeat : undefined,
    whitelist: Array.isArray(fm.whitelist) ? fm.whitelist.filter((x): x is string => typeof x === "string") : [],
    commercial: fm.commercial === true,
    job: concept.body.trim(),
    relPath: concept.relPath,
  };
}

export function agentsFromBundle(bundle: Bundle): AgentConcept[] {
  return conceptsByType(bundle, "agent").map(agentFromConcept);
}

/**
 * What actually thinks for this agent right now: the frontmatter
 * declaration unless the instance config redirects that harness
 * (`cognition.overrides` — the vendor-outage knob). Reports record the
 * EFFECTIVE pair — evidence describes what ran, not what was hoped for.
 */
export function effectiveCognition(
  agent: AgentConcept,
  config: InstanceConfig,
): { harness: string; model: string } {
  const override = config.cognition?.overrides?.[agent.harness];
  if (!override) return { harness: agent.harness, model: agent.model };
  return { harness: override.harness ?? agent.harness, model: override.model ?? agent.model };
}

export function findAgent(bundle: Bundle, name: string): AgentConcept {
  const agents = agentsFromBundle(bundle);
  const found = agents.find((a) => a.name === name);
  if (!found) {
    throw new Error(`agent '${name}' not found — available: ${agents.map((a) => a.name).join(", ") || "(none)"}`);
  }
  return found;
}

export class ActivationGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivationGateError";
  }
}

/**
 * D11: capability may be designed commercial-ready, but activation is
 * dual-gated — the boundary map must be verified AND an option trigger
 * (or explicit written waiver) must be on file. Enforced in code.
 */
export function assertActivatable(agent: AgentConcept, config: InstanceConfig): void {
  if (!agent.commercial) return;
  const activation = config.activation ?? {};
  const boundaryOk = activation.boundaryMapVerified === true;
  const triggerOk = Boolean(activation.optionTrigger) || activation.founderWaiver === true;
  if (!boundaryOk || !triggerOk) {
    throw new ActivationGateError(
      `agent '${agent.name}' is commercial and dual-gated (D11): ` +
        `boundaryMapVerified=${String(activation.boundaryMapVerified ?? false)}, ` +
        `optionTrigger=${String(activation.optionTrigger ?? null)}, ` +
        `founderWaiver=${String(activation.founderWaiver ?? false)} — ` +
        `capability never outruns permission`,
    );
  }
}
