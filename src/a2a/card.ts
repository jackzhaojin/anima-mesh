import { loadBundle } from "../okf/bundle.js";
import { loadInstance } from "../instance/config.js";
import { buildAgentCardFromBundle, type AgentCard } from "./card-core.js";

export { buildAgentCardFromBundle, type AgentCard, type AgentCardSkill } from "./card-core.js";

/** Filesystem convenience wrapper (Node-only; Workers use card-core). */
export async function buildAgentCard(instanceRoot: string): Promise<AgentCard> {
  const instance = loadInstance(instanceRoot);
  const bundle = await loadBundle(instance.bundleDir);
  return buildAgentCardFromBundle(bundle, instance.config);
}
