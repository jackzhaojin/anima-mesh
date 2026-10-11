import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

/**
 * Engine templates ship with the package (templates/ at the repo root) and
 * are resolved relative to this module so both tsx (src/) and built (dist/)
 * execution find them.
 */
export function templatesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/init → ../../templates ; dist/init → ../../templates
  return path.resolve(here, "..", "..", "templates");
}

export function listAgentTemplates(): string[] {
  return readdirSync(path.join(templatesDir(), "agents"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

/**
 * A template by name. When a brain kind is given, a kind-specific variant
 * (templates/agents/<kind>/<name>.md - e.g. a person brain's hub) wins over
 * the base template; kinds without variants fall through to the base.
 */
export function loadAgentTemplate(name: string, kind?: string): string {
  if (kind) {
    try {
      return readFileSync(path.join(templatesDir(), "agents", kind, `${name}.md`), "utf8");
    } catch {
      /* no variant for this kind - the base template applies */
    }
  }
  const file = path.join(templatesDir(), "agents", `${name}.md`);
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Error(`unknown agent template '${name}' — available: ${listAgentTemplates().join(", ")}`);
  }
}

/** Kind-specific variants shipped for a brain kind (e.g. person → chief-of-staff, compliance-ops). */
export function listKindTemplates(kind: string): string[] {
  try {
    return readdirSync(path.join(templatesDir(), "agents", kind))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/** {{KEY}} substitution — deliberately dumb; templates are data, not code. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}
