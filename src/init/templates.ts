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

export function loadAgentTemplate(name: string): string {
  const file = path.join(templatesDir(), "agents", `${name}.md`);
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Error(`unknown agent template '${name}' — available: ${listAgentTemplates().join(", ")}`);
  }
}

/** {{KEY}} substitution — deliberately dumb; templates are data, not code. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}
