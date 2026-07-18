import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { LocalFileEntry, SourceFs } from "./types.js";

/**
 * Node implementation of the SourceFs capability — a bounded recursive walk
 * of a local directory. This module imports node built-ins and therefore
 * lives OUTSIDE the Worker import graph (enforced by workers-imports.test):
 * the Node harness wrappers inject it; Workers never see it.
 *
 * The walk cannot know .gitignore semantics, so callers pass explicit
 * excludes; a few never-useful names are always skipped.
 */
const ALWAYS_EXCLUDE = new Set([".git", "node_modules", ".DS_Store"]);

function excluded(relPath: string, name: string, excludes: string[]): boolean {
  if (ALWAYS_EXCLUDE.has(name)) return true;
  for (const entry of excludes) {
    if (!entry) continue;
    if (name === entry) return true;
    if (relPath === entry || relPath.startsWith(`${entry}/`)) return true;
  }
  return false;
}

export const nodeSourceFs: SourceFs = {
  async listFiles(rootAbs, opts) {
    const entries: LocalFileEntry[] = [];
    let truncated = false;
    // Depth-first in sorted order ⇒ deterministic listings run over run.
    const walk = async (dirAbs: string, prefix: string): Promise<void> => {
      const names = (await fs.readdir(dirAbs, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const dirent of names) {
        if (truncated) return;
        const relPath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
        if (excluded(relPath, dirent.name, opts.excludes)) continue;
        const abs = path.join(dirAbs, dirent.name);
        if (dirent.isDirectory()) {
          await walk(abs, relPath);
        } else if (dirent.isFile()) {
          if (entries.length >= opts.maxEntries) {
            truncated = true;
            return;
          }
          const stat = await fs.stat(abs);
          entries.push({ path: relPath, size: stat.size, lastModified: stat.mtime.toISOString() });
        }
        // Symlinks and specials are skipped: a read source lists documents,
        // and following links could escape the declared root.
      }
    };
    await walk(rootAbs, "");
    return { entries, truncated };
  },

  async readTextFile(rootAbs, relPath) {
    const abs = path.resolve(rootAbs, relPath);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
      throw new Error(`local source: '${relPath}' escapes the source root`);
    }
    return fs.readFile(abs, "utf8");
  },
};
