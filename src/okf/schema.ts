import type { Bundle, Concept } from "./bundle-core.js";
import { conceptsByType } from "./bundle-core.js";

/**
 * Concept types as declared schemas - the ontology layer (v2.0.0).
 *
 * OKF says every concept has a `type`; until now a type was only a word.
 * A `concept-type` concept turns the word into a contract, the way an
 * object type does in an ontology: named properties with kinds, required
 * fields, closed vocabularies, and typed links to other concept types.
 * The schema lives IN the bundle - the ontology is knowledge, versioned
 * with everything else, editable by the people it describes.
 *
 * ```yaml
 * type: concept-type
 * name: commitment            # the type this schema governs
 * title: Commitment
 * strict: true                # violations are errors (default: warnings)
 * properties:
 *   status: { kind: enum, values: [planned, confirmed, delivered], required: true }
 *   date:   { kind: date, required: true }
 *   with:   { kind: link, target: crm-person }
 * ```
 *
 * Open world on purpose: properties a schema does not name are allowed
 * (frontmatter stays extensible); what a schema names, it enforces.
 * Pure and Workers-safe.
 */

export const SCHEMA_TYPE = "concept-type";

export type PropertyKind = "string" | "number" | "boolean" | "date" | "enum" | "list" | "link" | "slug";
export const PROPERTY_KINDS: readonly PropertyKind[] = ["string", "number", "boolean", "date", "enum", "list", "link", "slug"];

export interface PropertySpec {
  kind: PropertyKind;
  required: boolean;
  /** enum (or list of enum) vocabulary. */
  values?: string[];
  /** list element kind (default string). */
  of?: PropertyKind;
  /** link: the concept type the target must have (a relative .md path, resolved in-bundle). */
  target?: string;
  description?: string;
}

export interface ConceptSchema {
  name: string;
  title?: string;
  strict: boolean;
  properties: Record<string, PropertySpec>;
  relPath: string;
}

export interface SchemaIssue {
  level: "error" | "warning";
  rule: string;
  path?: string;
  message: string;
}

function asSpec(raw: unknown): PropertySpec | string {
  // Shorthand: `date: date` or `status: [a, b]` (an enum).
  if (typeof raw === "string") {
    return PROPERTY_KINDS.includes(raw as PropertyKind) ? { kind: raw as PropertyKind, required: false } : `unknown kind '${raw}'`;
  }
  if (Array.isArray(raw)) {
    return raw.every((v) => typeof v === "string") ? { kind: "enum", values: raw as string[], required: false } : "enum shorthand must be a list of strings";
  }
  if (typeof raw !== "object" || raw === null) return "property spec must be a kind, an enum list, or a map";
  const r = raw as Record<string, unknown>;
  const kind = (r.kind ?? (Array.isArray(r.values) ? "enum" : "string")) as PropertyKind;
  if (!PROPERTY_KINDS.includes(kind)) return `unknown kind '${String(r.kind)}' (kinds: ${PROPERTY_KINDS.join(", ")})`;
  const spec: PropertySpec = { kind, required: r.required === true };
  if (r.values !== undefined) {
    if (!Array.isArray(r.values) || !r.values.every((v) => typeof v === "string")) return "`values` must be a list of strings";
    spec.values = r.values as string[];
  }
  if ((kind === "enum" || (kind === "list" && r.of === "enum")) && !spec.values?.length) return "an enum needs `values`";
  if (r.of !== undefined) {
    if (!PROPERTY_KINDS.includes(r.of as PropertyKind) || r.of === "list") return `list \`of\` must be a scalar kind, got '${String(r.of)}'`;
    spec.of = r.of as PropertyKind;
  }
  if (r.target !== undefined) {
    if (typeof r.target !== "string") return "`target` must be a concept type name";
    spec.target = r.target;
  }
  if (typeof r.description === "string") spec.description = r.description;
  return spec;
}

/** Every schema the bundle declares, plus problems with the schemas themselves. */
export function loadSchemas(bundle: Bundle): { schemas: Map<string, ConceptSchema>; issues: SchemaIssue[] } {
  const schemas = new Map<string, ConceptSchema>();
  const issues: SchemaIssue[] = [];
  for (const c of conceptsByType(bundle, SCHEMA_TYPE)) {
    const fm = c.frontmatter;
    if (typeof fm.name !== "string" || !fm.name.trim()) {
      issues.push({ level: "error", rule: "ontology/schema-name", path: c.relPath, message: "a concept-type must name the type it governs (`name:`)" });
      continue;
    }
    if (schemas.has(fm.name)) {
      issues.push({
        level: "error",
        rule: "ontology/schema-duplicate",
        path: c.relPath,
        message: `type '${fm.name}' already has a schema at ${schemas.get(fm.name)!.relPath}`,
      });
      continue;
    }
    const properties: Record<string, PropertySpec> = {};
    const rawProps = fm.properties ?? {};
    if (typeof rawProps !== "object" || rawProps === null || Array.isArray(rawProps)) {
      issues.push({ level: "error", rule: "ontology/schema-shape", path: c.relPath, message: "`properties` must be a map of name → spec" });
      continue;
    }
    for (const [prop, raw] of Object.entries(rawProps as Record<string, unknown>)) {
      const spec = asSpec(raw);
      if (typeof spec === "string") {
        issues.push({ level: "error", rule: "ontology/schema-property", path: c.relPath, message: `property '${prop}': ${spec}` });
      } else {
        properties[prop] = spec;
      }
    }
    schemas.set(fm.name, {
      name: fm.name,
      ...(typeof fm.title === "string" ? { title: fm.title } : {}),
      strict: fm.strict === true,
      properties,
      relPath: c.relPath,
    });
  }
  return { schemas, issues };
}

function isDateValue(v: unknown): boolean {
  return v instanceof Date || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v));
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** POSIX resolve of `target` against the directory of `relPath`; null if it escapes the bundle. */
export function resolveRelative(relPath: string, target: string): string | null {
  const baseParts = relPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (baseParts.length === 0) return null;
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join("/");
}

function checkScalar(
  kind: PropertyKind,
  value: unknown,
  spec: PropertySpec,
  ctx: { concept: Concept; byPath: Map<string, Concept> },
): string | undefined {
  switch (kind) {
    case "string":
      return typeof value === "string" ? undefined : "must be text";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : "must be a number";
    case "boolean":
      return typeof value === "boolean" ? undefined : "must be true or false";
    case "date":
      return isDateValue(value) ? undefined : "must be a date (yyyy-mm-dd)";
    case "slug":
      return typeof value === "string" && SLUG_RE.test(value) ? undefined : "must be a lowercase slug";
    case "enum":
      return typeof value === "string" && (spec.values ?? []).includes(value)
        ? undefined
        : `must be one of ${(spec.values ?? []).join(" | ")}, got ${JSON.stringify(value)}`;
    case "link": {
      if (typeof value !== "string") return "must be a relative .md path or a brain:// reference";
      if (/^[a-z]+:\/\//i.test(value)) return undefined; // cross-brain or URL: checked elsewhere (brains)
      const resolved = resolveRelative(ctx.concept.relPath, value);
      const target = resolved === null ? undefined : ctx.byPath.get(resolved);
      if (!target) return `link '${value}' does not resolve to a concept in this bundle`;
      if (spec.target && target.frontmatter.type !== spec.target) {
        return `link '${value}' points at a '${String(target.frontmatter.type)}', expected '${spec.target}'`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Validate every concept whose type has a schema. Pure. */
export function checkSchemas(bundle: Bundle): SchemaIssue[] {
  const { schemas, issues } = loadSchemas(bundle);
  if (schemas.size === 0) return issues;
  const byPath = new Map(bundle.concepts.map((c) => [c.relPath, c]));
  for (const concept of bundle.concepts) {
    if (concept.parseError || concept.missingFrontmatter) continue;
    const type = concept.frontmatter.type;
    if (typeof type !== "string") continue;
    const schema = schemas.get(type);
    if (!schema) continue;
    const level = schema.strict ? "error" : "warning";
    for (const [prop, spec] of Object.entries(schema.properties)) {
      const value = concept.frontmatter[prop];
      if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
        if (spec.required) {
          issues.push({ level, rule: "ontology/required", path: concept.relPath, message: `${type}.${prop} is required by ${schema.relPath}` });
        }
        continue;
      }
      let problem: string | undefined;
      if (spec.kind === "list") {
        if (!Array.isArray(value)) problem = "must be a list";
        else {
          for (const item of value) {
            problem = checkScalar(spec.of ?? "string", item, spec, { concept, byPath });
            if (problem) break;
          }
        }
      } else {
        problem = checkScalar(spec.kind, value, spec, { concept, byPath });
      }
      if (problem) issues.push({ level, rule: "ontology/property", path: concept.relPath, message: `${type}.${prop} ${problem}` });
    }
  }
  return issues;
}
