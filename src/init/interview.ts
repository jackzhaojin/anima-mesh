import { readFileSync } from "node:fs";
import * as readline from "node:readline/promises";
import type { AgentWorkerProvider } from "../providers/types.js";
import { listAgentTemplates } from "./templates.js";
import type { InitAnswers } from "./scaffold.js";

/**
 * Three ways to answer the init interview:
 *   1. --answers file.json          (non-interactive; CI and tests)
 *   2. interactive terminal prompts (a human standing up their own brain)
 *   3. agentic enrichment           (a provider turns a freeform description
 *                                    into the structured answers — the
 *                                    "interview me" of story-31)
 */
export function loadAnswersFile(file: string): InitAnswers {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<InitAnswers>;
  return normalizeAnswers(raw);
}

export function normalizeAnswers(raw: Partial<InitAnswers>): InitAnswers {
  if (!raw.orgName?.trim()) throw new Error("answers: orgName is required");
  if (!raw.principalName?.trim()) throw new Error("answers: principalName is required");
  const available = new Set(listAgentTemplates());
  const agents = (raw.agents ?? ["compliance-ops"]).filter((a) => {
    if (!available.has(a)) throw new Error(`answers: unknown agent template '${a}' — available: ${[...available].join(", ")}`);
    return true;
  });
  return { ...raw, orgName: raw.orgName.trim(), principalName: raw.principalName.trim(), agents } as InitAnswers;
}

export async function interactiveInterview(input = process.stdin, output = process.stdout): Promise<InitAnswers> {
  const rl = readline.createInterface({ input, output });
  try {
    const orgName = (await rl.question("Organization name: ")).trim();
    const principalName = (await rl.question("Principal (the human approval gate): ")).trim();
    const principalEmail = (await rl.question("Principal email (optional): ")).trim() || undefined;
    const personaName = (await rl.question("Mesh persona name (optional — your agents' shared identity): ")).trim() || undefined;
    const description = (await rl.question("One paragraph: what is this organization? ")).trim() || undefined;
    const available = listAgentTemplates();
    const agentsRaw = (
      await rl.question(`Agents to enable [${available.join(", ")}] (comma-separated, default compliance-ops): `)
    ).trim();
    const agents = agentsRaw ? agentsRaw.split(",").map((s) => s.trim()).filter(Boolean) : ["compliance-ops"];
    return normalizeAnswers({ orgName, principalName, principalEmail, personaName, description, agents });
  } finally {
    rl.close();
  }
}

/**
 * Agentic enrichment: hand a provider the freeform description and get back
 * refined answers — a suggested roster, a sharper organization description,
 * a starter calendar/watch-list the human then edits. The provider output is
 * advisory JSON; anything unparseable falls back to the human's answers
 * (model judgment proposes, deterministic code disposes).
 */
export async function agenticEnrich(
  answers: InitAnswers,
  provider: AgentWorkerProvider,
  opts: { cwd?: string; model?: string } = {},
): Promise<InitAnswers> {
  const available = listAgentTemplates();
  const prompt = [
    "You are the init interviewer for an AnimaMesh company-of-0 brain repo.",
    "Given this organization, return STRICT JSON (no fences, no prose) with keys:",
    `{"description": string, "agents": string[] (subset of: ${available.join(", ")}), "personaName": string|null}`,
    "Pick only agents this organization plausibly needs now; commercial ones (sales-qualification, lead-identification, inbound-triage) only when the description shows an active commercial motion.",
    "",
    `Organization: ${answers.orgName}`,
    `Principal: ${answers.principalName}`,
    `Description: ${answers.description ?? "(none given)"}`,
  ].join("\n");

  const result = await provider.run({ prompt, cwd: opts.cwd ?? process.cwd(), model: opts.model });
  try {
    const jsonText = extractJson(result.text);
    const suggestion = JSON.parse(jsonText) as { description?: string; agents?: string[]; personaName?: string | null };
    const suggestedAgents = (suggestion.agents ?? []).filter((a) => available.includes(a));
    return normalizeAnswers({
      ...answers,
      description: suggestion.description?.trim() || answers.description,
      agents: suggestedAgents.length > 0 ? suggestedAgents : answers.agents,
      personaName: answers.personaName ?? (suggestion.personaName?.trim() || undefined),
    });
  } catch {
    // Advisory only: a malformed model response never blocks an init.
    return answers;
  }
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1]!.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) return trimmed.slice(first, last + 1);
  throw new Error("no JSON found in provider response");
}
