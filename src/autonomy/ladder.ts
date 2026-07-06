/**
 * The autonomy ladder (D6): trust is an operational dial with a paper trail.
 * Every agent starts at L1; promotions are recorded in the agent's own
 * concept file — never in code.
 */
export type Level = "L1" | "L2" | "L3" | "L4";

/**
 * Action categories the harness understands:
 *  - report     — produce a report artifact (harness writes it)
 *  - draft      — produce a draft-for-approval artifact
 *  - reversible — whitelisted autonomous repo actions (commits, index updates)
 *  - external   — actions with effects outside the repo; ALWAYS per-action gated
 */
export type ActionCategory = "report" | "draft" | "reversible" | "external";

export const LEVELS: Level[] = ["L1", "L2", "L3", "L4"];

const ALLOWS: Record<Level, ReadonlySet<ActionCategory>> = {
  L1: new Set(["report"]),
  L2: new Set(["report", "draft"]),
  L3: new Set(["report", "draft", "reversible"]),
  L4: new Set(["report", "draft", "reversible", "external"]),
};

export function parseLevel(value: unknown): Level {
  if (value === "L1" || value === "L2" || value === "L3" || value === "L4") return value;
  throw new Error(`invalid autonomy level: ${JSON.stringify(value)} (expected L1|L2|L3|L4)`);
}

export function canPerform(level: Level, category: ActionCategory): boolean {
  return ALLOWS[level].has(category);
}

/** L4 never exempts an action from its gate — external stays per-action gated permanently. */
export function requiresGate(category: ActionCategory): boolean {
  return category === "external";
}
