import type { Bundle } from "./bundle-core.js";
import { loadSchemas, resolveRelative, SCHEMA_TYPE } from "./schema.js";

/**
 * The ontology view - what a brain knows, as types and the links between
 * them. Derived, never stored: the bundle is the ontology; this module only
 * reads it the way an ontology manager would (type catalog, link graph,
 * schema coverage, what crosses to other brains). Pure and Workers-safe.
 */

/** Types the engine itself gives meaning to - "schema: engine" in the catalog. */
export const ENGINE_TYPES = new Set([
  "index",
  "log",
  "constitution",
  "inherited-constitution",
  "agent",
  "decision",
  "event",
  "schedule",
  "calendar",
  "nags",
  "watchlist",
  SCHEMA_TYPE,
]);

export interface TypeEntry {
  type: string;
  count: number;
  schema: "declared" | "declared-strict" | "engine" | "none";
  /** Concepts of this type carrying a `share:` marking. */
  shared: number;
  example: string;
}

export interface LinkTypeEntry {
  from: string;
  to: string;
  count: number;
}

export interface OntologyView {
  concepts: number;
  types: TypeEntry[];
  /** Relative links between concepts, aggregated by (source type → target type). */
  linkTypes: LinkTypeEntry[];
  /** brain:// references by target brain id. */
  crossBrain: Record<string, number>;
  untyped: number;
}

const MD_LINK_RE = /\[[^\]]*\]\(([^)#?]+\.md)(?:[#?][^)]*)?\)/g;
const BRAIN_REF_RE = /brain:\/\/([a-z0-9][a-z0-9-]*)\//g;

export function buildOntology(bundle: Bundle): OntologyView {
  const { schemas } = loadSchemas(bundle);
  const byPath = new Map(bundle.concepts.map((c) => [c.relPath, c]));
  const types = new Map<string, TypeEntry>();
  const links = new Map<string, LinkTypeEntry>();
  const crossBrain: Record<string, number> = {};
  let untyped = 0;

  for (const c of bundle.concepts) {
    const type = typeof c.frontmatter.type === "string" && c.frontmatter.type ? c.frontmatter.type : undefined;
    if (!type) {
      untyped++;
      continue;
    }
    const schema = schemas.get(type);
    const entry =
      types.get(type) ??
      {
        type,
        count: 0,
        schema: schema ? (schema.strict ? "declared-strict" : "declared") : ENGINE_TYPES.has(type) ? "engine" : "none",
        shared: 0,
        example: c.relPath,
      };
    entry.count++;
    if (c.frontmatter.share !== undefined) entry.shared++;
    types.set(type, entry);

    for (const m of c.body.matchAll(MD_LINK_RE)) {
      const target = m[1]!;
      if (/^[a-z]+:\/\//i.test(target) || target.startsWith("/")) continue;
      const resolved = resolveRelative(c.relPath, target);
      const to = resolved === null ? undefined : byPath.get(resolved);
      const toType = to && typeof to.frontmatter.type === "string" ? to.frontmatter.type : undefined;
      if (!toType) continue;
      const key = `${type}\u0000${toType}`;
      const edge = links.get(key) ?? { from: type, to: toType, count: 0 };
      edge.count++;
      links.set(key, edge);
    }
    for (const m of c.body.matchAll(BRAIN_REF_RE)) {
      crossBrain[m[1]!] = (crossBrain[m[1]!] ?? 0) + 1;
    }
  }

  return {
    concepts: bundle.concepts.length,
    types: [...types.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    linkTypes: [...links.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)),
    crossBrain,
    untyped,
  };
}

export function formatOntology(view: OntologyView, title: string): string {
  const pad = (s: string, n: number) => (s.length >= n ? s + " " : s + " ".repeat(n - s.length));
  const lines = [`Ontology - ${title}: ${view.concepts} concept(s), ${view.types.length} type(s)`, ""];
  const width = Math.max(18, ...view.types.map((t) => t.type.length + 2));
  lines.push(pad("type", width) + pad("count", 7) + pad("schema", 17) + pad("shared", 8) + "example");
  for (const t of view.types) {
    lines.push(pad(t.type, width) + pad(String(t.count), 7) + pad(t.schema, 17) + pad(String(t.shared), 8) + t.example);
  }
  if (view.untyped > 0) lines.push("", `${view.untyped} concept(s) declare no type (conformance flags them).`);
  const unschematized = view.types.filter((t) => t.schema === "none");
  if (unschematized.length > 0) {
    lines.push(
      "",
      `Types without a schema: ${unschematized.map((t) => t.type).join(", ")} - declare one with a \`concept-type\` concept to make the word a contract.`,
    );
  }
  lines.push("", `Link types (relative links between concept types): ${view.linkTypes.length}`);
  for (const l of view.linkTypes) lines.push(`  ${l.from} → ${l.to}: ${l.count}`);
  const brains = Object.entries(view.crossBrain);
  if (brains.length > 0) {
    lines.push("", "Cross-brain references (brain://):");
    for (const [id, n] of brains.sort()) lines.push(`  ${id}: ${n}`);
  }
  return lines.join("\n");
}
