import type { BriefSettings } from "../harness/focus.js";

/**
 * The brief digest (v2.3.5): what actually reaches the principal.
 *
 * The hub writes a full report for the repo, but the notification is its
 * `## Brief` section, cut to `lines` lines in code, and the thread holds at
 * most `also` one-line items from `## Also` plus a link to the full report.
 * Everything else (the `## Detail`, the evidence) stays in git. A report
 * without a `## Brief` section is not posted whole: the principal gets its
 * first lines and a note that the format was missed, so a model ignoring
 * the contract degrades to "short and flagged", never to pages.
 *
 * Pure and Workers-safe.
 */

export interface BriefDigest {
  /** The notification: at most `lines` lines. */
  headline: string;
  /** The thread reply: the Also list (capped) and the link to the full report. */
  thread: string;
  /** False when the report had no `## Brief` section and the headline is a fallback. */
  followedFormat: boolean;
}

function sections(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of body.split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      const key = h[1]!.toLowerCase().replace(/[^a-z ].*$/, "").trim();
      current = out.has(key) ? null : [];
      if (current) out.set(key, current);
      continue;
    }
    if (/^#\s/.test(line)) {
      current = null;
      continue;
    }
    current?.push(line);
  }
  return out;
}

const contentLines = (lines: string[]) => lines.map((l) => l.trimEnd()).filter((l) => l.trim() !== "");

export function digestBrief(body: string, settings: BriefSettings, reportRef: string): BriefDigest {
  const parts = sections(body);
  const brief = parts.get("brief");
  const also = contentLines(parts.get("also") ?? []).filter((l) => /^\s*[-*]\s/.test(l));

  let headlineLines: string[];
  let overflow: string[] = [];
  const followedFormat = brief !== undefined && contentLines(brief).length > 0;
  if (followedFormat) {
    const lines = contentLines(brief!).map((l) => l.replace(/^\s*[-*]\s+/, ""));
    headlineLines = lines.slice(0, settings.lines);
    overflow = lines.slice(settings.lines).map((l) => `- ${l}`);
  } else {
    const fallback = contentLines(body.split("\n").filter((l) => !/^#{1,6}\s/.test(l) && !/^---\s*$/.test(l)));
    headlineLines = fallback.slice(0, settings.lines);
  }

  const items = [...overflow, ...also];
  const shown = items.slice(0, settings.also);
  const thread = [
    ...shown,
    ...(items.length > shown.length ? [`- ...and ${items.length - shown.length} more in the full report.`] : []),
    ...(shown.length || items.length ? [""] : []),
    ...(followedFormat ? [] : ["This report had no `## Brief` section, so the lines above are its first lines."]),
    `Full report: ${reportRef}`,
  ].join("\n");

  return {
    headline: headlineLines.join("\n") || "Nothing needs you today.",
    thread,
    followedFormat,
  };
}
