import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Minimal OKF v0.1 concept surface: one markdown file, YAML frontmatter
 * delimited by `---` lines, `type` required (enforced at conformance level,
 * not parse level — a parser that throws on missing type can't report it).
 */
export interface Frontmatter {
  type?: string;
  [key: string]: unknown;
}

export interface ParsedConcept {
  frontmatter: Frontmatter;
  body: string;
}

const FM_OPEN = /^---\r?\n/;

/**
 * Parse a concept file. Returns null when the file has no frontmatter block
 * at all (callers decide whether that's a conformance error).
 * Throws on malformed YAML inside an existing block — silent repair would
 * mask corruption in the firm's knowledge layer.
 */
export function parseConcept(raw: string): ParsedConcept | null {
  if (!FM_OPEN.test(raw)) return null;
  const rest = raw.replace(FM_OPEN, "");
  const closeIdx = rest.search(/^---\s*$/m);
  if (closeIdx === -1) return null;
  const yamlText = rest.slice(0, closeIdx);
  const afterClose = rest.slice(closeIdx);
  const body = afterClose.replace(/^---\s*\r?\n?/, "");
  const fm = parseYaml(yamlText) as Frontmatter | null;
  return { frontmatter: fm ?? {}, body };
}

export function serializeConcept(concept: ParsedConcept): string {
  const yamlText = stringifyYaml(concept.frontmatter).trimEnd();
  return `---\n${yamlText}\n---\n\n${concept.body.replace(/^\n+/, "")}`;
}
