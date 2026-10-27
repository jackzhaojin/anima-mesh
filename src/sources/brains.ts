import type { SourceContext } from "./types.js";
import type { BrainIdentity, BrainLinkConfig } from "../instance/config-core.js";
import type { InstanceStore } from "../instance/store.js";
import { getEnv } from "../instance/env-core.js";
import { GitHubInstanceStore } from "../instance/store-github.js";
import { isLocalMode } from "../instance/local-mode.js";
import {
  brainConfigProblems,
  computeExport,
  readOnlyStore,
  INVERSE_RELATION,
  type BrainExport,
} from "../brains/core.js";

/**
 * The 'brains' source - what LINKED brains share with this one, inlined
 * read-only. Workers-safe.
 *
 * Transports, tried in order (first usable wins):
 * - local checkout (link.localPath) - Node tier only, through the injected
 *   ctx.openLocalBrain capability; fresh, tokenless.
 * - the linked repo (link.repo) over GitHub, with a READ-ONLY token from
 *   the link's own env var (link.tokenEnv, default BRAIN_LINK_<ID>_TOKEN).
 *   There is deliberately no fallback to this brain's GITHUB_TOKEN: each
 *   link gets its own least-privilege credential, or it is not read.
 *
 * Failure posture matches every source: a link that cannot be read yields
 * an honest line naming why, and the run continues.
 */

export const BRAINS_SOURCE = "brains";

const PER_CONCEPT_CHARS = 6_000;
const BRIEF_CHARS = 8_000;
const PER_LINK_CHARS = 30_000;

/** The env var a link's read token lives in. */
export function linkTokenEnv(link: BrainLinkConfig): string {
  return link.tokenEnv ?? `BRAIN_LINK_${link.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
}

type Opened = { store: InstanceStore; via: string } | { gap: string };

/** Open a linked brain read-only over the first usable transport. */
export function openLinkedBrain(link: BrainLinkConfig, ctx: SourceContext): Opened {
  const gaps: string[] = [];
  if (link.localPath) {
    const local = ctx.openLocalBrain?.(link);
    if (local) return { store: readOnlyStore(local), via: `local checkout ${link.localPath}` };
    gaps.push(ctx.openLocalBrain ? `no brain found at ${link.localPath}` : "local checkouts are not reachable on this tier");
  }
  if (link.repo && isLocalMode(ctx.config)) {
    gaps.push("local mode reads linked brains only from local checkouts");
  } else if (link.repo) {
    const tokenName = linkTokenEnv(link);
    const token = getEnv(ctx.env, tokenName);
    if (token) {
      return {
        store: readOnlyStore(new GitHubInstanceStore({ repo: link.repo, ref: link.ref, token, fetchImpl: ctx.fetchImpl })),
        via: `github ${link.repo}@${link.ref ?? "main"}`,
      };
    }
    gaps.push(`${tokenName} is not set (a read-only token for ${link.repo})`);
  }
  if (!link.localPath && !link.repo) gaps.push("the link declares no transport (localPath or repo)");
  return { gap: gaps.join("; ") };
}

export interface LinkedRead {
  link: BrainLinkConfig;
  via?: string;
  view?: BrainExport;
  /** Why nothing was read - always set when `view` is absent. */
  problem?: string;
}

/**
 * Read one link: open it, ask the EXPORTER what it gives this brain, then
 * verify the relationship from both sides. Any disagreement reads nothing.
 */
export async function readLinkedBrain(
  link: BrainLinkConfig,
  self: BrainIdentity,
  ctx: SourceContext,
  exportOpts: { maxConcepts?: number } = {},
): Promise<LinkedRead> {
  const opened = openLinkedBrain(link, ctx);
  if ("gap" in opened) return { link, problem: `not reachable on this tier - ${opened.gap}` };
  try {
    const result = await computeExport(opened.store, self.id, exportOpts);
    if (!result.ok) return { link, via: opened.via, problem: result.reason };
    const { view } = result;
    if (view.brain.id !== link.id) {
      return { link, via: opened.via, problem: `identity mismatch: the brain at ${opened.via} is '${view.brain.id}', not '${link.id}'` };
    }
    const expected = INVERSE_RELATION[link.relation];
    if (view.relation !== expected) {
      return {
        link,
        via: opened.via,
        problem:
          `relationship mismatch: this brain declares itself '${link.relation}' ${link.id}, but ${link.id} declares ` +
          `itself '${view.relation}' this brain (expected '${expected}') - fix one side; nothing was read`,
      };
    }
    return { link, via: opened.via, view };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log?.(`brains source: ${link.id} failed: ${message}`);
    return { link, via: opened.via, problem: `unreadable this run: ${message}` };
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n…(truncated by the harness)" : text;
}

function renderLink(read: LinkedRead): string {
  const { link, view } = read;
  if (!view) {
    return `\n### \`${link.id}\` - NOT READ\n\n_(${read.problem}. Treat everything from this brain as a data gap this run - do not reason from recall.)_`;
  }
  const name = view.brain.name ? `${view.brain.name} (${view.brain.kind})` : view.brain.kind;
  const role = link.role ? ` (role: ${link.role})` : "";
  const parts = [`\n### \`${link.id}\` - ${name} · this brain is ${link.relation} it${role} · via ${read.via}`];
  let budget = PER_LINK_CHARS;

  for (const c of view.constitutions ?? []) {
    const body = clip(c.content, Math.min(PER_CONCEPT_CHARS, budget));
    budget -= body.length;
    parts.push(
      `\n#### Inherited constitution from \`${c.from}\` - BINDING on this brain`,
      "The gates in code enforce the materialized copy under inherited/ (refresh with `anima-mesh brains sync`); this is the live text.",
      "",
      body,
    );
  }

  if (view.brief && budget > 0) {
    const body = clip(view.brief.content, Math.min(BRIEF_CHARS, budget));
    budget -= body.length;
    parts.push(`\n#### Latest brief from its hub - reports/${view.brief.name}`, "", body);
  }

  const shown = view.concepts.length;
  parts.push(
    `\n#### Shared with this brain: ${shown + view.omitted} of ${view.totalConcepts} concept(s)` +
      (view.omitted > 0 ? ` (${view.omitted} over the export cap, not shown)` : ""),
  );
  if (shown === 0) parts.push("_(nothing in that brain is marked for this brain)_");
  const skipped: string[] = [];
  for (const c of view.concepts) {
    if (budget <= 0) {
      skipped.push(c.relPath);
      continue;
    }
    const body = clip(c.content, Math.min(PER_CONCEPT_CHARS, budget));
    budget -= body.length;
    parts.push(`\n##### brain://${link.id}/${c.relPath}\n\n${body}`);
  }
  if (skipped.length > 0) {
    parts.push(`\n(${skipped.length} shared concept(s) NOT inlined - the per-brain budget is spent: ${skipped.map((p) => `brain://${link.id}/${p}`).join(", ")})`);
  }
  return parts.join("\n");
}

/** The ambient section for agents that declare `sources: [brains]`. */
export async function brainsSection(ctx: SourceContext): Promise<string> {
  const heading = "\n## Linked brains (read-only views, filtered by each brain's own `share:` markings)";
  const config = ctx.config;
  if (!config) return `${heading}\n\n_(declared for this agent, but the harness passed no instance config - report this as an engine issue)_`;
  const problems = brainConfigProblems(config);
  if (problems.length > 0) {
    return `${heading}\n\n_(this brain's link config is invalid, so no linked brain was read: ${problems.join("; ")})_`;
  }
  if (!config.brain) {
    return `${heading}\n\n_(declared for this agent, but this brain declares no identity (brain.id) - it cannot read other brains)_`;
  }
  const links = config.links ?? [];
  if (links.length === 0) return `${heading}\n\n_(declared for this agent, but this brain declares no links)_`;

  const parts = [
    heading,
    "",
    "Other brains this brain is linked to. Each shows ONLY what that brain chose to share with this one -",
    "deny-by-default, enforced in code by the brain that owns the data. These are THAT brain's facts, not",
    "this brain's: cite them as `brain://<id>/<path>`. You cannot write to a linked brain; anything it needs",
    "from this brain's principal goes in your report as a proposal.",
  ];
  for (const link of links) {
    parts.push(renderLink(await readLinkedBrain(link, config.brain, ctx)));
  }
  return parts.join("\n");
}

/**
 * On-demand read of one shared concept (read-request `brains: [<id>/<path>]`).
 * "Not shared" and "does not exist" are the same answer on purpose - a
 * read-request must never become an existence oracle for private concepts.
 */
export async function readBrainPath(ctx: SourceContext, requestPath: string, opts: { maxChars: number }): Promise<string> {
  const config = ctx.config;
  if (!config?.brain) throw new Error("this brain declares no identity - it cannot read other brains");
  const problems = brainConfigProblems(config);
  if (problems.length > 0) throw new Error(`this brain's link config is invalid: ${problems[0]}`);
  const slash = requestPath.indexOf("/");
  if (slash <= 0) throw new Error("brains paths are <brain-id>/<bundle path>, e.g. org/ops/calendar.md");
  const id = requestPath.slice(0, slash);
  const rel = requestPath.slice(slash + 1);
  const link = (config.links ?? []).find((l) => l.id === id);
  if (!link) throw new Error(`this brain has no link to '${id}'`);
  // No export cap here: a concept past the ambient cap is still shared.
  const read = await readLinkedBrain(link, config.brain, ctx, { maxConcepts: Number.MAX_SAFE_INTEGER });
  if (!read.view) throw new Error(read.problem ?? "not readable");
  const found = read.view.concepts.find((c) => c.relPath === rel);
  if (!found) throw new Error(`'${rel}' is not shared with this brain by '${id}' (or does not exist)`);
  return clip(found.content, opts.maxChars);
}
