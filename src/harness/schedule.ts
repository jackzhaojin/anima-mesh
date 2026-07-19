import { parse as parseYaml } from "yaml";
import { parseConcept, serializeConcept } from "../okf/frontmatter.js";
import { conceptsByType, type Bundle } from "../okf/bundle-core.js";
import type { InstanceStore } from "../instance/store.js";
import type { InstanceConfig } from "../instance/config-core.js";
import type { AgentConcept } from "../agents/concept.js";

/**
 * The schedule surface: `ops/schedule.md` in the bundle — standing overrides
 * and one-shot wakes, read by the due decision every beat. Declared cadence
 * stays in each agent's frontmatter; the ledger stays the record of what ran;
 * next-fire time is always DERIVED from those two. This file holds only the
 * knobs a human (by commit) or a whitelisted agent (via a gated
 * `schedule-request` block in its report) may turn:
 *
 *  - `wake:`    agent names to run at the next beat regardless of cadence.
 *               Consumed — removed here, in the beat's own commit — when the
 *               run is attempted. A wake an agent's tier or gates can't honor
 *               stays visible instead of vanishing.
 *  - `pause:`   agent names the beat skips until removed. Pause beats wake:
 *               an explicit stop outranks an explicit go, and the contradiction
 *               stays on file for the principal to see.
 *  - `cadence:` per-agent overrides of the concept's `heartbeat:` value —
 *               declared-vs-effective, same pattern as cognition.overrides.
 */
export const SCHEDULE_RELPATH = "ops/schedule.md";

export interface Schedule {
  wake: string[];
  pause: string[];
  cadence: Record<string, string>;
}

export const EMPTY_SCHEDULE: Schedule = { wake: [], pause: [], cadence: {} };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

function normalize(fm: Record<string, unknown>): Schedule {
  const cadence: Record<string, string> = {};
  const raw = fm.cadence;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim() !== "") cadence[k] = v;
    }
  }
  return { wake: [...new Set(strings(fm.wake))], pause: [...new Set(strings(fm.pause))], cadence };
}

/** Tolerant read: a missing or shapeless schedule concept is an empty schedule, never an error. */
export function scheduleFromBundle(bundle: Bundle): Schedule {
  const concept = conceptsByType(bundle, "schedule")[0];
  if (!concept || concept.parseError || concept.missingFrontmatter) return { ...EMPTY_SCHEDULE };
  return normalize(concept.frontmatter);
}

/** The declared cadence unless the schedule overrides it — declared vs. effective. */
export function effectiveCadence(agent: AgentConcept, schedule: Schedule): string | undefined {
  return schedule.cadence[agent.name] ?? agent.heartbeat;
}

const DEFAULT_BODY = [
  "# Schedule — overrides and one-shot wakes",
  "",
  "The due decision reads the frontmatter above at every beat:",
  "",
  "- `wake:` — run these agents at the next beat regardless of cadence;",
  "  consumed in the beat's own commit once the run is attempted.",
  "- `pause:` — skip these agents until removed. Pause beats wake.",
  "- `cadence:` — per-agent override of the concept's `heartbeat:` value",
  "  (daily | weekly | monthly | quarterly).",
  "",
  "Edit by hand and commit, or let a whitelisted agent request wakes with a",
  "`schedule-request` block in its report. Next-fire time is derived from",
  "cadence and the ledger — it is never stored here.",
  "",
].join("\n");

/**
 * Read-modify-write of the schedule file through the store seam, preserving
 * any human prose in the body and any unrelated frontmatter keys. The
 * mutator returns the next schedule, or null for "no change" (no write).
 * Creates the file on first use.
 */
export async function mutateSchedule(
  store: InstanceStore,
  config: InstanceConfig,
  fn: (current: Schedule) => Schedule | null,
): Promise<Schedule | null> {
  const relPath = `${config.bundle}/${SCHEDULE_RELPATH}`;
  const raw = await store.readOptional(relPath);
  // Malformed YAML throws in parseConcept — corruption in the knowledge
  // layer must be loud, not silently rewritten.
  const parsed = raw === null ? null : parseConcept(raw);
  const frontmatter: Record<string, unknown> = parsed ? { ...parsed.frontmatter } : {};
  const next = fn(normalize(frontmatter));
  if (next === null) return null;

  frontmatter.type = "schedule";
  if (typeof frontmatter.title !== "string") frontmatter.title = "Schedule — overrides and one-shot wakes";
  frontmatter.wake = [...new Set(next.wake)].sort();
  frontmatter.pause = [...new Set(next.pause)].sort();
  frontmatter.cadence = next.cadence;

  const body = parsed?.body?.trim() ? parsed.body : DEFAULT_BODY;
  await store.writeFile(relPath, serializeConcept({ frontmatter, body }));
  return normalize(frontmatter);
}

const REQUEST_RE = /```schedule-request\s*\r?\n([\s\S]*?)```/;

/**
 * Extract a `schedule-request` fenced block from a run's output text.
 * Advisory input from a model: anything malformed is null, never a throw —
 * the gate (level + whitelist) decides whether a well-formed request applies.
 */
export function parseScheduleRequest(text: string): string[] | null {
  const match = REQUEST_RE.exec(text);
  if (!match) return null;
  try {
    const parsed = parseYaml(match[1]!) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const wake = [...new Set(strings((parsed as Record<string, unknown>).wake))];
    return wake.length > 0 ? wake : null;
  } catch {
    return null;
  }
}
