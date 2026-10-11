import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { makeTree, concept, minimalAnimaMeshFiles } from "./helpers.js";
import { loadBundle } from "../src/okf/bundle.js";
import { checkConformance } from "../src/okf/conformance.js";
import { checkSchemas, loadSchemas } from "../src/okf/schema.js";
import { buildOntology, formatOntology } from "../src/okf/ontology.js";

/**
 * The ontology layer (v0.18.0): a `concept-type` concept turns a type word
 * into a contract - properties with kinds, required fields, closed
 * vocabularies, typed links. What must hold: schemas are opt-in per type;
 * what a schema names it enforces (warnings, or errors when strict); the
 * schemas themselves are validated; the ontology view is derived, never
 * stored.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

const commitmentSchema = (strict: boolean) =>
  concept(
    "concept-type",
    {
      name: "commitment",
      title: "Commitment",
      strict,
      properties: {
        status: { kind: "enum", values: ["planned", "confirmed", "delivered"], required: true },
        date: { kind: "date", required: true },
        with: { kind: "link", target: "person" },
        tags: { kind: "list", of: "enum", values: ["talk", "family"] },
        paid: "boolean",
      },
    },
    "# Commitment\n\nSomething the principal promised.\n",
  );

async function bundleWith(files: Record<string, string>) {
  const root = await makeTree({ ...minimalAnimaMeshFiles(), ...files });
  roots.push(root);
  return loadBundle(root);
}

describe("concept-type schemas", () => {
  it("a conforming concept passes; schemas are opt-in per type", async () => {
    const bundle = await bundleWith({
      "ontology/commitment.md": commitmentSchema(true),
      "people/kim.md": concept("person", {}, "# Kim\n"),
      "commitments/talk.md": concept(
        "commitment",
        { status: "confirmed", date: "2026-11-02", with: "../people/kim.md", tags: ["talk"], paid: false },
        "# A talk\n",
      ),
      "facts/free-form.md": concept("fact", { anything: 1 }, "# No schema, no checks\n"),
    });
    expect(checkSchemas(bundle)).toEqual([]);
    expect(checkConformance(bundle, "animamesh").ok).toBe(true);
  });

  it("enforces required, enum, date, list, boolean, and typed links", async () => {
    const bundle = await bundleWith({
      "ontology/commitment.md": commitmentSchema(true),
      "facts/not-a-person.md": concept("fact", {}, "# Fact\n"),
      "commitments/bad.md": concept(
        "commitment",
        { status: "maybe", with: "../facts/not-a-person.md", tags: ["talk", "nope"], paid: "yes" },
        "# Bad\n",
      ),
      "commitments/dangling.md": concept("commitment", { status: "planned", date: "soon", with: "../people/ghost.md" }, "# D\n"),
    });
    const messages = checkSchemas(bundle).map((i) => `${i.path}: ${i.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/bad\.md: commitment\.status must be one of planned \| confirmed \| delivered/),
        expect.stringMatching(/bad\.md: commitment\.date is required/),
        expect.stringMatching(/bad\.md: commitment\.with link .* points at a 'fact', expected 'person'/),
        expect.stringMatching(/bad\.md: commitment\.tags must be one of talk \| family, got "nope"/),
        expect.stringMatching(/bad\.md: commitment\.paid must be true or false/),
        expect.stringMatching(/dangling\.md: commitment\.date must be a date/),
        expect.stringMatching(/dangling\.md: commitment\.with link '\.\.\/people\/ghost\.md' does not resolve/),
      ]),
    );
    // strict ⇒ errors ⇒ the bundle fails conformance (and so run verification)
    expect(checkConformance(bundle, "animamesh").ok).toBe(false);
  });

  it("non-strict schemas warn without failing the bundle", async () => {
    const bundle = await bundleWith({
      "ontology/commitment.md": commitmentSchema(false),
      "commitments/bad.md": concept("commitment", { status: "maybe" }, "# Bad\n"),
    });
    const report = checkConformance(bundle, "animamesh");
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.rule.startsWith("ontology/")).every((i) => i.level === "warning")).toBe(true);
  });

  it("validates the schemas themselves", async () => {
    const bundle = await bundleWith({
      "ontology/a.md": concept("concept-type", { name: "thing", properties: { x: { kind: "colour" } } }, "# A\n"),
      "ontology/b.md": concept("concept-type", { name: "thing" }, "# B\n"),
      "ontology/c.md": concept("concept-type", { properties: {} }, "# C\n"),
      "ontology/d.md": concept("concept-type", { name: "other", properties: { e: { kind: "enum" } } }, "# D\n"),
    });
    const { issues } = loadSchemas(bundle);
    const rules = issues.map((i) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(["ontology/schema-property", "ontology/schema-duplicate", "ontology/schema-name"]));
    expect(issues.some((i) => /an enum needs `values`/.test(i.message))).toBe(true);
    expect(checkConformance(bundle, "okf").ok).toBe(false);
  });
});

describe("the ontology view", () => {
  it("catalogs types, schema coverage, markings, link types, and cross-brain references", async () => {
    const bundle = await bundleWith({
      "ontology/commitment.md": commitmentSchema(false),
      "people/kim.md": concept("person", { share: ["org"] }, "# Kim\n"),
      "commitments/one.md": concept("commitment", { status: "planned", date: "2026-11-02" }, "With [Kim](../people/kim.md); see brain://org/ops/calendar.md.\n"),
      "commitments/two.md": concept("commitment", { status: "planned", date: "2026-11-03" }, "With [Kim](../people/kim.md).\n"),
    });
    const view = buildOntology(bundle);
    const byType = Object.fromEntries(view.types.map((t) => [t.type, t]));
    expect(byType.commitment).toMatchObject({ count: 2, schema: "declared" });
    expect(byType.person).toMatchObject({ count: 1, schema: "none", shared: 1 });
    expect(byType.constitution?.schema).toBe("engine");
    expect(view.linkTypes).toContainEqual({ from: "commitment", to: "person", count: 2 });
    expect(view.crossBrain).toEqual({ org: 1 });
    const text = formatOntology(view, "test");
    expect(text).toContain("Types without a schema: person");
    expect(text).toContain("commitment → person: 2");
  });
});
