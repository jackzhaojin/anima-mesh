import type { SourceContext } from "./types.js";
import { listCabinet, cabinetListingMarkdown, msGraphConfigured } from "./msgraph.js";
import { listDocs, docsListingMarkdown, githubDocsConfigured } from "./github-docs.js";

/**
 * Source registry — Workers-safe (fetch-based sources only, injected env).
 * An agent opts in via `sources:` in its concept frontmatter; the harness
 * inlines each source's context section at prompt-assembly time.
 *
 * Failure posture: a source that is declared but unconfigured or unreachable
 * yields an HONEST section saying so — context absence must be visible to
 * the model (and thus the report), and must never abort the run.
 */
export const KNOWN_SOURCES = ["onedrive", "github-docs"] as const;

export async function sourceSections(sourceNames: string[], ctx: SourceContext): Promise<string[]> {
  const sections: string[] = [];
  for (const name of sourceNames) {
    if (name === "onedrive") {
      sections.push(await onedriveSection(ctx));
    } else if (name === "github-docs") {
      sections.push(await githubDocsSection(ctx));
    } else {
      sections.push(`\n## Source '${name}'\n\n_(unknown source — the engine knows: ${KNOWN_SOURCES.join(", ")})_`);
    }
  }
  return sections;
}

async function onedriveSection(ctx: SourceContext): Promise<string> {
  const heading = "\n## Filing cabinet (OneDrive via Microsoft Graph, read-only)";
  if (!msGraphConfigured(ctx)) {
    return `${heading}\n\n_(declared for this agent but not configured here — MSGRAPH_CLIENT_ID/MSGRAPH_REFRESH_TOKEN absent; note the gap rather than guessing at cabinet contents)_`;
  }
  try {
    const listing = await listCabinet(ctx);
    return `${heading}\n\nLive listing fetched this run. Folder and file names, sizes, and modified dates are current facts you may rely on; file CONTENTS are not shown here.\n\n${cabinetListingMarkdown(listing)}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log?.(`onedrive source failed: ${message}`);
    return `${heading}\n\n_(configured but unreachable this run: ${message} — report this as an operational issue; do not guess at cabinet contents)_`;
  }
}

async function githubDocsSection(ctx: SourceContext): Promise<string> {
  const heading = "\n## Docs repo (git-hosted document corpus, read-only)";
  if (!githubDocsConfigured(ctx)) {
    return `${heading}\n\n_(declared for this agent but not configured here — GITHUB_DOCS_REPO and GITHUB_DOCS_LOCAL_PATH both absent; note the gap rather than guessing at repo contents)_`;
  }
  try {
    const listing = await listDocs(ctx);
    return `${heading}\n\nLive listing fetched this run from ${listing.origin}. Paths, sizes, and modified dates are current facts you may rely on; file CONTENTS are not shown here.\n\n${docsListingMarkdown(listing)}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log?.(`github-docs source failed: ${message}`);
    return `${heading}\n\n_(configured but unreachable this run: ${message} — report this as an operational issue; do not guess at repo contents)_`;
  }
}
