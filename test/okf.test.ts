import { describe, it, expect, afterEach } from "vitest";
import { parseConcept, serializeConcept } from "../src/okf/frontmatter.js";
import { loadBundle, getConcept, conceptsByType } from "../src/okf/bundle.js";
import { checkConformance } from "../src/okf/conformance.js";
import { makeTree, cleanup, concept, minimalOkfFiles, minimalAnimaMeshFiles } from "./helpers.js";

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTree(files);
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) await cleanup(roots.pop()!);
});

describe("frontmatter", () => {
  it("parses type and body", () => {
    const parsed = parseConcept("---\ntype: fact\ntitle: T\n---\n\nBody here\n");
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.type).toBe("fact");
    expect(parsed!.frontmatter.title).toBe("T");
    expect(parsed!.body.trim()).toBe("Body here");
  });

  it("returns null when there is no frontmatter block", () => {
    expect(parseConcept("# Just markdown\n")).toBeNull();
    expect(parseConcept("text\n---\ntype: x\n---\n")).toBeNull();
  });

  it("returns null when the block never closes", () => {
    expect(parseConcept("---\ntype: fact\n")).toBeNull();
  });

  it("throws on malformed YAML instead of silently repairing", () => {
    expect(() => parseConcept("---\ntype: [unclosed\n---\n\nbody\n")).toThrow();
  });

  it("round-trips through serialize", () => {
    const original = { frontmatter: { type: "decision", date: "2026-07-05" }, body: "# D\n\nText.\n" };
    const reparsed = parseConcept(serializeConcept(original));
    expect(reparsed!.frontmatter.type).toBe("decision");
    expect(reparsed!.body).toContain("# D");
  });

  it("handles --- inside the body", () => {
    const parsed = parseConcept("---\ntype: fact\n---\n\nabove\n\n---\n\nbelow\n");
    expect(parsed!.body).toContain("above");
    expect(parsed!.body).toContain("below");
  });
});

describe("bundle loading", () => {
  it("walks nested dirs, skips dotdirs, sorts deterministically", async () => {
    const root = await tree({
      ...minimalOkfFiles(),
      "facts/a.md": concept("fact", {}, "A"),
      "deep/nested/b.md": concept("fact", {}, "B"),
      ".hidden/skipme.md": concept("fact", {}, "no"),
      "notes.txt": "not markdown",
    });
    const bundle = await loadBundle(root);
    const rels = bundle.concepts.map((c) => c.relPath);
    expect(rels).toContain("facts/a.md");
    expect(rels).toContain("deep/nested/b.md");
    expect(rels).not.toContain(".hidden/skipme.md");
    expect(rels).not.toContain("notes.txt");
    expect([...rels].sort()).toEqual(rels);
  });

  it("flags missing frontmatter and parse errors without dying", async () => {
    const root = await tree({
      ...minimalOkfFiles(),
      "bare.md": "# no frontmatter\n",
      "broken.md": "---\ntype: [oops\n---\n\nbody\n",
    });
    const bundle = await loadBundle(root);
    expect(getConcept(bundle, "bare.md")!.missingFrontmatter).toBe(true);
    expect(getConcept(bundle, "broken.md")!.parseError).toBeTruthy();
  });

  it("selects by type", async () => {
    const root = await tree({
      ...minimalOkfFiles(),
      "d1.md": concept("decision", { date: "2026-07-05" }, "D1"),
      "d2.md": concept("decision", { date: "2026-07-05" }, "D2"),
    });
    const bundle = await loadBundle(root);
    expect(conceptsByType(bundle, "decision")).toHaveLength(2);
  });
});

describe("conformance — okf profile", () => {
  it("passes a minimal valid bundle", async () => {
    const bundle = await loadBundle(await tree(minimalOkfFiles()));
    const report = checkConformance(bundle, "okf");
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("fails on missing index.md / log.md", async () => {
    const bundle = await loadBundle(await tree({ "log.md": concept("log", {}, "") }));
    const report = checkConformance(bundle, "okf");
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.rule)).toContain("okf/index");
  });

  it("fails on concepts without a type", async () => {
    const bundle = await loadBundle(
      await tree({ ...minimalOkfFiles(), "untyped.md": "---\ntitle: no type\n---\n\nbody\n" }),
    );
    const report = checkConformance(bundle, "okf");
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.rule === "okf/type-required" && i.path === "untyped.md")).toBe(true);
  });

  it("fails on missing/broken frontmatter", async () => {
    const bundle = await loadBundle(
      await tree({ ...minimalOkfFiles(), "bare.md": "# nope\n", "broken.md": "---\ntype: [x\n---\nbody\n" }),
    );
    const report = checkConformance(bundle, "okf");
    const rules = report.issues.map((i) => i.rule);
    expect(rules).toContain("okf/frontmatter-missing");
    expect(rules).toContain("okf/frontmatter-parse");
  });

  it("warns (not errors) on broken relative links", async () => {
    const bundle = await loadBundle(
      await tree({
        ...minimalOkfFiles(),
        "a.md": concept("fact", {}, "See [gone](./missing.md) and [ok](index.md) and [web](https://example.com/x.md)."),
      }),
    );
    const report = checkConformance(bundle, "okf");
    expect(report.ok).toBe(true);
    const broken = report.issues.filter((i) => i.rule === "okf/broken-link");
    expect(broken).toHaveLength(1);
    expect(broken[0]!.message).toContain("missing.md");
  });
});

describe("conformance — animamesh profile", () => {
  it("passes the minimal animamesh bundle", async () => {
    const bundle = await loadBundle(await tree(minimalAnimaMeshFiles()));
    expect(checkConformance(bundle, "animamesh").ok).toBe(true);
  });

  it("requires a constitution", async () => {
    const bundle = await loadBundle(await tree(minimalOkfFiles()));
    const report = checkConformance(bundle, "animamesh");
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.rule)).toContain("animamesh/constitution");
  });

  it("requires the constitution to be immutable", async () => {
    const bundle = await loadBundle(
      await tree({ ...minimalOkfFiles(), "constitution.md": concept("constitution", {}, "# C") }),
    );
    const report = checkConformance(bundle, "animamesh");
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.rule)).toContain("animamesh/constitution-immutable");
  });

  it("requires dates on decisions and events", async () => {
    const bundle = await loadBundle(
      await tree({ ...minimalAnimaMeshFiles(), "decisions/d.md": concept("decision", {}, "undated") }),
    );
    const report = checkConformance(bundle, "animamesh");
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.rule === "animamesh/dated" && i.path === "decisions/d.md")).toBe(true);
  });

  it("requires agent concepts to declare model, harness, and a valid level", async () => {
    const bundle = await loadBundle(
      await tree({
        ...minimalAnimaMeshFiles(),
        "agents/good.md": concept("agent", { level: "L1", model: "m", harness: "fake" }, "job"),
        "agents/bad.md": concept("agent", { level: "L9" }, "job"),
      }),
    );
    const report = checkConformance(bundle, "animamesh");
    expect(report.ok).toBe(false);
    const badIssues = report.issues.filter((i) => i.path === "agents/bad.md");
    expect(badIssues.some((i) => i.rule === "animamesh/agent-chokepoint")).toBe(true);
    expect(badIssues.some((i) => i.rule === "animamesh/agent-level")).toBe(true);
    expect(report.issues.filter((i) => i.path === "agents/good.md")).toHaveLength(0);
  });
});
