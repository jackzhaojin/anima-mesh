import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { parseConcept } from "./frontmatter.js";
import type { Bundle, Concept } from "./bundle-core.js";

export { getConcept, conceptsByType, type Bundle, type Concept } from "./bundle-core.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        await walk(path.join(dir, entry.name), out);
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path.join(dir, entry.name));
    }
  }
}

/** Load every markdown concept under a bundle root. */
export async function loadBundle(root: string): Promise<Bundle> {
  const rootAbs = path.resolve(root);
  const files: string[] = [];
  await walk(rootAbs, files);
  files.sort();

  const concepts: Concept[] = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const relPath = path.relative(rootAbs, file).split(path.sep).join("/");
    try {
      const parsed = parseConcept(raw);
      if (parsed === null) {
        concepts.push({
          path: file,
          relPath,
          frontmatter: {},
          body: raw,
          missingFrontmatter: true,
        });
      } else {
        concepts.push({
          path: file,
          relPath,
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          missingFrontmatter: false,
        });
      }
    } catch (err) {
      concepts.push({
        path: file,
        relPath,
        frontmatter: {},
        body: raw,
        missingFrontmatter: false,
        parseError: String(err),
      });
    }
  }
  return { root: rootAbs, concepts };
}
