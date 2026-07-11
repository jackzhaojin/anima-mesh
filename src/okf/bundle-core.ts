import type { Frontmatter } from "./frontmatter.js";

/**
 * Bundle types + pure helpers — Workers-safe (no node built-ins). Disk
 * loading lives in bundle.ts; remote loading in instance/store-github.ts.
 */
export interface Concept {
  /** Absolute path on disk (fs bundles); equals relPath for remote bundles. */
  path: string;
  /** Path relative to the bundle root, POSIX separators. */
  relPath: string;
  frontmatter: Frontmatter;
  body: string;
  /** True when the file had no frontmatter block at all. */
  missingFrontmatter: boolean;
  /** Set when the frontmatter block existed but failed to parse. */
  parseError?: string;
}

export interface Bundle {
  root: string;
  concepts: Concept[];
}

export function getConcept(bundle: Bundle, relPath: string): Concept | undefined {
  return bundle.concepts.find((c) => c.relPath === relPath);
}

export function conceptsByType(bundle: Bundle, type: string): Concept[] {
  return bundle.concepts.filter((c) => c.frontmatter.type === type);
}
