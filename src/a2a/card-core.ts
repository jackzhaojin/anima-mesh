import { getConcept, type Bundle } from "../okf/bundle-core.js";
import { agentsFromBundle, assertActivatable } from "../agents/concept.js";
import type { InstanceConfig } from "../instance/config-core.js";

/**
 * The mesh's public A2A Agent Card, exposed through the hub (the Chief of
 * Staff is the mesh's front door). Ships early because it is nearly free and
 * makes the mesh spec-conformant when hosted — `url` is where the card would
 * live (`/.well-known/agent-card.json`); local-era instances carry a URN.
 *
 * Commercial agents that fail their activation gate are not advertised:
 * the card shows what the mesh will actually do. Workers-safe.
 */
export interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
}

export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentCardSkill[];
}

/** Pure assembly from an already-loaded bundle + config. */
export function buildAgentCardFromBundle(bundle: Bundle, config: InstanceConfig): AgentCard {
  const agents = agentsFromBundle(bundle);

  const index = getConcept(bundle, "index.md");
  const meshTitle =
    (typeof index?.frontmatter.title === "string" && index.frontmatter.title) || "AnimaMesh instance";
  const persona = config.identity?.persona?.name;

  const skills: AgentCardSkill[] = [];
  for (const agent of agents) {
    if (agent.commercial) {
      try {
        assertActivatable(agent, config);
      } catch {
        continue; // not advertised until the dual gate opens
      }
    }
    const firstLine = agent.job
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && !l.startsWith(">"));
    skills.push({
      id: agent.name,
      name: agent.title,
      description: firstLine ?? agent.title,
    });
  }

  return {
    protocolVersion: "1.0",
    name: persona ? `${persona} — Chief of Staff` : meshTitle,
    description:
      `Agentic back office mesh (${meshTitle}). One coordinating hub over ${skills.length} ` +
      `specialist capabilities; every consequential action gated on a human principal.`,
    url: config.a2a?.url ?? "urn:anima-mesh:local-instance",
    version: config.engine?.ref ?? "dev",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/markdown"],
    skills,
  };
}
