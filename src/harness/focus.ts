import type { InstanceStore } from "../instance/store.js";
import type { InstanceConfig } from "../instance/config-core.js";
import { parseConcept, serializeConcept } from "../okf/frontmatter.js";
import { assertActionAllowed, GateViolation } from "../gates/gatekeeper.js";
import type { ApprovalRecord } from "../gates/approvals.js";
import type { Level } from "../autonomy/ladder.js";

/**
 * Focus (v2.3.5): the principal's priority dial, `ops/focus.md`.
 *
 * A brain with many agents finds something to say about everything, and a
 * daily brief that covers everything is a brief nobody reads. The focus
 * concept says what matters right now: top of mind, secondary, tertiary,
 * areas that stay quiet unless a stated exception fires, and topics that
 * are hands-off because another session owns them. Every agent reads it
 * first, every run; the hub shapes the brief by it; and delivery sends only
 * the brief's first lines (channels/brief-core.ts), so length is enforced
 * in code, not hoped for in a prompt.
 *
 * Only the principal moves the dial. A direction run may rewrite it with a
 * `focus-update` block when its whitelist allows; a scheduled beat never
 * applies one, so the mesh cannot decide for itself what matters.
 *
 * Workers-safe: no node imports.
 */

export const FOCUS_RELPATH = "ops/focus.md";
export const MAX_FOCUS_BYTES = 16 * 1024;
/** A focus nobody has touched in a month is probably not the focus any more. */
export const FOCUS_FRESH_DAYS = 30;

export interface BriefSettings {
  /** Lines of the channel notification (the `## Brief` section). */
  lines: number;
  /** One-line items in the thread (the `## Also` section). */
  also: number;
}

export const DEFAULT_BRIEF: BriefSettings = { lines: 3, also: 8 };

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}

/** `brief: { lines, also }` from the focus frontmatter, clamped to sane bounds. */
export function briefSettingsFrom(frontmatter: Record<string, unknown> | undefined): BriefSettings {
  const b = (frontmatter?.brief ?? {}) as Record<string, unknown>;
  return {
    lines: clampInt(b.lines, 1, 10, DEFAULT_BRIEF.lines),
    also: clampInt(b.also, 0, 30, DEFAULT_BRIEF.also),
  };
}

export interface Focus {
  raw: string;
  body: string;
  frontmatter: Record<string, unknown>;
  brief: BriefSettings;
}

/** The brain's focus concept, or null when it has none (focus is opt-in). */
export async function loadFocus(store: InstanceStore, config: InstanceConfig): Promise<Focus | null> {
  const raw = await store.readOptional(`${config.bundle}/${FOCUS_RELPATH}`);
  if (raw === null || raw.trim() === "") return null;
  let parsed: ReturnType<typeof parseConcept> = null;
  try {
    parsed = parseConcept(raw);
  } catch {
    parsed = null; // malformed YAML still reads as prose; conformance reports it
  }
  const frontmatter = (parsed?.frontmatter ?? {}) as Record<string, unknown>;
  return { raw, body: (parsed?.body ?? raw).trim(), frontmatter, brief: briefSettingsFrom(frontmatter) };
}

/**
 * The focus section, inlined FIRST in every agent's bundle context (beats
 * and directions alike) with the engine's reading of it stated once.
 */
export function focusContextSection(focus: Focus): string {
  return [
    `\n### ${FOCUS_RELPATH} - the principal's priorities (read this first; it outranks every other section)`,
    "Weigh everything below by it. Top of mind leads. Secondary and tertiary items get one line at most.",
    "A quiet area stays silent unless its stated exception fires (then say which exception). A hands-off",
    "topic is never raised, worked on, drafted or nagged: another session owns it. Answer about it only",
    "when the principal asks directly, and then point to where it is handled. Where your job asks for a",
    "standing section about a quiet area, skip that section.",
    "",
    focus.body,
  ].join("\n");
}

/**
 * The report contract for the hub's scheduled brief. Delivery enforces the
 * line counts; this tells the hub what those lines are for.
 */
export function briefFormatLines(focus: Focus | null): string[] {
  const s = focus?.brief ?? DEFAULT_BRIEF;
  const lines = [
    "",
    "## Report format: the brief (the principal reads three lines, not pages)",
    "Delivery sends ONLY your `## Brief` and `## Also` sections; everything else stays in the repo behind",
    "a link. Write the report in this order:",
    `1. \`## Brief\` - at most ${s.lines} line(s), no headings or sub-bullets. Only what needs the principal`,
    "   today: top-of-mind items, and any quiet-area exception that fired. Each line is one complete",
    "   thought with its ask or deadline. If nothing does: the single line `Nothing needs you today.`",
    `2. \`## Also\` - at most ${s.also} one-line items, highest priority first, each written`,
    "   `- P2 · category: item` (P2 = secondary, P3 = tertiary). Quiet areas and hands-off topics never",
    "   appear here unless an exception fired. A nag that has not moved in two weeks and is not top of",
    "   mind gets at most one line a week (`P3 · nags: #N name - still want this?`), never a daily repeat.",
    "3. `## Detail` - anything you or the other agents need for later: evidence, reasoning, full status.",
    "   Never sent; keep it as short as it can be and still be useful.",
    "Your job description may ask for other brief sections or orderings; this format and the focus win.",
  ];
  if (!focus) {
    lines.push(
      `There is no \`${FOCUS_RELPATH}\` yet, so nothing tells you what matters. Make one Also line ask the`,
      "principal to set their focus (top of mind, secondary, tertiary, quiet, hands-off).",
    );
  } else if (focusIsStale(focus)) {
    lines.push(
      `\`${FOCUS_RELPATH}\` has not been updated in over ${FOCUS_FRESH_DAYS} days. Make one Also line ask the`,
      "principal whether it still holds.",
    );
  }
  return lines;
}

/** True when the focus is past `stale_after`, or undated/older than FOCUS_FRESH_DAYS. */
export function focusIsStale(focus: Focus, now: Date = new Date()): boolean {
  const staleAfter = focus.frontmatter.stale_after;
  const at = staleAfter instanceof Date ? staleAfter : typeof staleAfter === "string" ? new Date(staleAfter) : null;
  if (at && !Number.isNaN(at.getTime())) return now.getTime() > at.getTime();
  const date = focus.frontmatter.date;
  const d = date instanceof Date ? date : typeof date === "string" ? new Date(date) : null;
  if (!d || Number.isNaN(d.getTime())) return true;
  return now.getTime() - d.getTime() > FOCUS_FRESH_DAYS * 86_400_000;
}

// ---- the principal moves the dial: focus-update in direction runs ----------

const BLOCK_RE = /```focus-update\s*\r?\n([\s\S]*?)```/;

/** The new focus body from the first `focus-update` block (one update per run), or null. */
export function parseFocusUpdate(text: string): string | null {
  const m = BLOCK_RE.exec(text);
  const body = m?.[1]?.trim();
  return body ? body : null;
}

/** Remove focus-update blocks from text bound for a chat reply. */
export function stripFocusUpdates(text: string): string {
  return text.replace(new RegExp(BLOCK_RE.source, "g"), "").replace(/\n{3,}/g, "\n\n");
}

/** Capability lines for a direction run whose agent may update the focus. */
export function focusCapabilityLines(): string[] {
  return [
    `- When the principal asks to change what matters (raise, lower, quiet or hand off an area or topic),`,
    `  rewrite the focus in this run and confirm the change in one sentence. End with exactly one block`,
    "  holding the COMPLETE new body of the focus file (markdown, no frontmatter; keep its sections):",
    "  ```focus-update",
    "  # Focus",
    "  ## Top of mind",
    "  - ...",
    "  ```",
    "  Only the principal can move the focus: never update it on a teammate's say-so or your own idea.",
  ];
}

export interface ApplyFocusOptions {
  store: InstanceStore;
  config: InstanceConfig;
  agent: { name: string; level: Level; whitelist: string[] };
  runId: string;
  gatedTypes: string[];
  approvals: Map<string, ApprovalRecord>;
  clock: () => string;
  text: string;
  /** Whether the message came from the principal (a direct message or a configured focus editor). */
  fromPrincipal: boolean;
  /** Local date stamp (YYYY-MM-DD) for the focus `date:`. */
  dateStamp: string;
  /** OKF actor for `generated.by`: `<harness>/<model>`. */
  actor: string;
  progress: (note: string) => void;
}

const DEFAULT_FRONTMATTER = {
  type: "focus",
  title: "Focus - what matters right now",
  description: "The principal's priority dial: what leads the brief, what gets one line, what stays quiet, what is hands-off.",
};

/** Apply a `focus-update` block. Returns the written path, or null. Every outcome is ledgered. */
export async function applyFocusUpdate(options: ApplyFocusOptions): Promise<string | null> {
  const { store, config, agent, runId, clock, progress } = options;
  const body = parseFocusUpdate(options.text);
  if (body === null) return null;
  const rel = `${config.bundle}/${FOCUS_RELPATH}`;
  const deny = async (reason: string) => {
    await store.appendLedger({
      ts: clock(),
      runId,
      agent: agent.name,
      action: "focus-update-denied",
      type: "focus-update",
      detail: { path: rel, reason },
    });
    progress(`direction ${runId.slice(0, 8)}: focus-update denied - ${reason}`);
    return null;
  };

  if (!options.fromPrincipal) return deny("only the principal may change the focus (sender is not a focus editor)");
  if (body.length > MAX_FOCUS_BYTES) return deny(`content exceeds ${MAX_FOCUS_BYTES} bytes`);
  try {
    assertActionAllowed({
      agent: agent.name,
      level: agent.level,
      category: "reversible",
      actionType: "focus-update",
      gatedTypes: options.gatedTypes,
      approvals: { get: (id) => options.approvals.get(id) },
      whitelist: agent.whitelist,
    });
  } catch (err) {
    if (!(err instanceof GateViolation)) throw err;
    return deny(err.message);
  }

  const existing = await store.readOptional(rel);
  let frontmatter: Record<string, unknown> = { ...DEFAULT_FRONTMATTER };
  try {
    const parsed = existing ? parseConcept(existing) : null;
    if (parsed) frontmatter = { ...frontmatter, ...parsed.frontmatter };
  } catch {
    /* a malformed old header is replaced, not preserved */
  }
  const stale = new Date(`${options.dateStamp}T00:00:00Z`);
  stale.setUTCDate(stale.getUTCDate() + FOCUS_FRESH_DAYS);
  frontmatter.type = "focus";
  frontmatter.date = options.dateStamp;
  frontmatter.stale_after = stale.toISOString().replace(".000Z", "Z");
  frontmatter.generated = { by: options.actor, at: clock() };
  await store.writeFile(rel, serializeConcept({ frontmatter, body: `${body}\n` }));
  await store.appendLedger({
    ts: clock(),
    runId,
    agent: agent.name,
    action: "focus-updated",
    type: "focus-update",
    detail: { path: rel, bytes: body.length },
  });
  progress(`direction ${runId.slice(0, 8)}: focus updated - ${rel}`);
  return rel;
}
