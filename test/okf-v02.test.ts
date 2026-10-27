import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { loadBundle } from "../src/okf/bundle.js";
import { checkConformance } from "../src/okf/conformance.js";
import { checkSchemas } from "../src/okf/schema.js";
import {
  parseActor,
  trustTier,
  lifecycle,
  isStale,
  isOkfDateTime,
  checkFamilies,
  trustDigest,
  provenance,
  generatedAt,
} from "../src/okf/trust.js";
import { addLogEntry, checkLog, convertLegacyLog } from "../src/okf/log.js";
import { migrateFile, migrateBundle } from "../src/okf/migrate.js";
import { agentFromConcept } from "../src/agents/concept.js";
import { knowledgeTrustSection } from "../src/harness/run-core.js";
import { buildAgentCardFromBundle } from "../src/a2a/card-core.js";
import { main } from "../src/cli.js";
import type { Concept } from "../src/okf/bundle-core.js";
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

function fake(frontmatter: Record<string, unknown>, body = "", relPath = "x.md"): Concept {
  return { path: relPath, relPath, frontmatter, body, missingFrontmatter: false };
}

describe("OKF v0.2 trust, lifecycle, provenance (SPEC §5, §7)", () => {
  it("parses the three actor forms and rejects free text", () => {
    expect(parseActor("human:ada")).toMatchObject({ kind: "human", id: "ada" });
    expect(parseActor("process:nightly")).toMatchObject({ kind: "process", id: "nightly" });
    expect(parseActor("claude-code/claude-opus-5-5")).toMatchObject({ kind: "agent" });
    expect(parseActor("Ada Founder")).toBeNull();
    expect(parseActor("session read of original, 2026-07-06")).toBeNull();
  });

  it("requires an explicit offset on every datetime", () => {
    expect(isOkfDateTime("2026-06-30T14:00:00Z")).toBe(true);
    expect(isOkfDateTime("2026-06-30T14:00:00-04:00")).toBe(true);
    expect(isOkfDateTime("2026-06-30T14:00:00")).toBe(false);
    expect(isOkfDateTime("2026-06-30")).toBe(false);
  });

  it("derives trust tiers; a bare verified mapping is a one-element list", () => {
    expect(trustTier({})).toBe("unverified");
    expect(trustTier({ verified: { by: "process:nightly", at: "2026-06-26T02:00:00Z" } })).toBe("machine-confirmed");
    expect(
      trustTier({
        verified: [
          { by: "process:nightly", at: "2026-06-26T02:00:00Z" },
          { by: "human:ada", at: "2026-06-25T09:00:00Z" },
        ],
      }),
    ).toBe("human-reviewed");
    // A malformed entry never forges a tier.
    expect(trustTier({ verified: "yes" })).toBe("unverified");
  });

  it("absent status is stable; staleness is a plain comparison", () => {
    expect(lifecycle({})).toBe("stable");
    expect(lifecycle({ status: "deprecated" })).toBe("deprecated");
    const fm = { stale_after: "2026-09-23T00:00:00Z" };
    expect(isStale(fm, new Date("2026-09-22T23:59:59Z"))).toBe(false);
    expect(isStale(fm, new Date("2026-09-23T00:00:00Z"))).toBe(true);
  });

  it("reads provenance entries and falls back to the v0.1 timestamp", () => {
    expect(provenance({ sources: [{ id: "a", resource: "https://x" }, "bare"] })).toHaveLength(1);
    expect(generatedAt({ timestamp: "2026-05-28T22:53:05+00:00" })).toBe(Date.parse("2026-05-28T22:53:05+00:00"));
    expect(generatedAt({ generated: { by: "human:ada", at: "2026-06-01T00:00:00Z" }, timestamp: "2020-01-01T00:00:00Z" })).toBe(
      Date.parse("2026-06-01T00:00:00Z"),
    );
  });

  it("warns on every malformed family, never errors", () => {
    const rules = (fm: Record<string, unknown>, body = "") => checkFamilies(fake(fm, body)).map((i) => i.rule);
    expect(rules({ status: "verified" })).toContain("okf/status");
    expect(rules({ generated: { by: "Ada", at: "2026-06-01T00:00:00Z" } })).toContain("okf/actor");
    expect(rules({ verified: { by: "human:ada", at: "2026-06-01" } })).toContain("okf/datetime");
    expect(rules({ stale_after: "next year" })).toContain("okf/datetime");
    expect(rules({ sources: ["just a string"] })).toContain("okf/sources");
    expect(rules({ sources: [{ id: "a", resource: "r" }] }, "Claim.[^b]\n\n[^b]: B")).toContain("okf/footnote-source");
    expect(rules({ sources: [{ id: "a", resource: "r" }] }, "Claim.[^a]\n\n[^a]: A")).toEqual([]);
    expect(rules({ timestamp: "2026-05-28T22:53:05+00:00" })).toContain("okf/legacy-timestamp");
    expect(rules({}, "# Citations\n- https://x\n")).toContain("okf/legacy-citations");
    expect(rules({ type: "Attested Computation" })).toEqual(
      expect.arrayContaining(["okf/computation-runtime", "okf/computation-body"]),
    );
    expect(checkFamilies(fake({ status: "nope" })).every((i) => i.level === "warning")).toBe(true);
  });

  it("a fully populated v0.2 concept (the spec's own example) is clean", () => {
    const c = fake(
      {
        type: "Attested Computation",
        status: "stable",
        runtime: "bigquery",
        generated: { by: "reference_agent/gemini-2.5-pro", at: "2026-06-20T22:53:05Z" },
        verified: { by: "human:ahormati", at: "2026-06-25T09:00:00Z" },
        stale_after: "2026-09-23T00:00:00Z",
        sources: [{ id: "rev-policy", resource: "https://wiki.acme/finance/revenue-recognition", author: "team:finance-fpa" }],
      },
      "# Computation\n\n    SELECT 1\n\nPer policy.[^rev-policy]\n\n[^rev-policy]: Revenue recognition policy\n",
    );
    expect(checkFamilies(c)).toEqual([]);
  });
});

describe("OKF v0.2 conformance profile", () => {
  it("reserved files are not concepts: no type needed, legacy frontmatter only warns", async () => {
    const bundle = await loadBundle(
      await tree({
        "index.md": "---\ntype: index\ntitle: Old\n---\n\n# Old\n",
        "log.md": "---\ntype: log\n---\n\n# Log\n",
        "sub/index.md": "# Sub\n\n* [a](a.md) - a\n",
        "sub/a.md": concept("fact", {}, "A"),
      }),
    );
    const report = checkConformance(bundle, "okf");
    expect(report.ok).toBe(true);
    const rules = report.issues.map((i) => i.rule);
    expect(rules).toContain("okf/index-frontmatter");
    expect(rules).toContain("okf/log-frontmatter");
    expect(rules).toContain("okf/version");
    expect(rules).not.toContain("okf/type-required");
  });

  it("a declared okf_version 0.2 root is clean; another version is best-effort", async () => {
    const clean = await loadBundle(await tree(minimalOkfFiles()));
    expect(checkConformance(clean, "okf").issues).toEqual([]);
    const other = await loadBundle(await tree({ ...minimalOkfFiles(), "index.md": '---\nokf_version: "0.3"\n---\n\n# I\n' }));
    const r = checkConformance(other, "okf");
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.message).join()).toMatch(/best-effort/);
  });

  it("checks bundle-relative /links from the root", async () => {
    const bundle = await loadBundle(
      await tree({ ...minimalOkfFiles(), "facts/a.md": concept("fact", {}, "[ok](/facts/b.md) [gone](/facts/nope.md)"), "facts/b.md": concept("fact", {}, "B") }),
    );
    const broken = checkConformance(bundle, "okf").issues.filter((i) => i.rule === "okf/broken-link");
    expect(broken).toHaveLength(1);
    expect(broken[0]!.message).toContain("/facts/nope.md");
  });

  it("the animamesh profile flags read-source opt-ins still under `sources:`", async () => {
    const agent = (fm: string) => `---\ntype: agent\nlevel: L1\nmodel: m\nharness: fake\n${fm}\n---\n\nJob.\n`;
    const bundle = await loadBundle(
      await tree({ ...minimalAnimaMeshFiles(), "agents/old.md": agent("sources: [onedrive]"), "agents/new.md": agent("context-sources: [onedrive]") }),
    );
    const flagged = checkConformance(bundle, "animamesh").issues.filter((i) => i.rule === "animamesh/agent-context-sources");
    expect(flagged.map((i) => i.path)).toEqual(["agents/old.md"]);
  });

  it("the animamesh profile warns (never errors) on layouts past three folders or dated records outside a year; constitution links are pinned", async () => {
    const bundle = await loadBundle(
      await tree({
        ...minimalAnimaMeshFiles(),
        "constitution.md": concept("constitution", { immutable: true }, "# C\n\nSee [the seam](decisions/2026-07-05-seam.md).\n"),
        "decisions/2026-07-05-seam.md": concept("decision", { date: "2026-07-05", status: "accepted" }, "Pinned by law."),
        "events/2026-10-01-flat.md": concept("event", { date: "2026-10-01" }, "Flat."),
        "events/2026/20261002-filed.md": concept("event", { date: "2026-10-02" }, "Filed."),
        "decisions/2026/20261003-chose.md": concept("decision", { date: "2026-10-03", status: "accepted" }, "Chose."),
        "professional/2026/20261111-talk/notes.md": concept("reference", {}, "Three deep is fine."),
        "professional/2026/20261111-talk/prep/notes.md": concept("reference", {}, "Four is too deep."),
      }),
    );
    const report = checkConformance(bundle, "animamesh");
    expect(report.ok).toBe(true);
    const byRule = (rule: string) => report.issues.filter((i) => i.rule === rule).map((i) => [i.level, i.path]);
    expect(byRule("animamesh/layout-year")).toEqual([["warning", "events/2026-10-01-flat.md"]]);
    expect(byRule("animamesh/layout-depth")).toEqual([["warning", "professional/2026/20261111-talk/prep/notes.md"]]);
    // The plain OKF profile has no layout opinion.
    expect(checkConformance(bundle, "okf").issues.map((i) => i.rule)).not.toContain("animamesh/layout-depth");
  });

  it("a schema may not give `status` domain values; lifecycle values are fine", async () => {
    const schema = (values: string) =>
      `---\ntype: concept-type\nname: commitment\nproperties:\n  status: { kind: enum, values: ${values} }\n---\n\nSchema.\n`;
    const bad = await loadBundle(await tree({ ...minimalOkfFiles(), "ontology/c.md": schema("[planned, delivered]") }));
    expect(checkSchemas(bad).map((i) => i.rule)).toContain("ontology/reserved-property");
    const ok = await loadBundle(await tree({ ...minimalOkfFiles(), "ontology/c.md": schema("[draft, stable, deprecated]") }));
    expect(checkSchemas(ok).map((i) => i.rule)).not.toContain("ontology/reserved-property");
  });
});

describe("OKF v0.2 log files (SPEC §9)", () => {
  it("writes newest first: a new day goes on top, the same day tops its group", () => {
    let log = addLogEntry(null, "2026-10-10", "- **Creation**: first");
    log = addLogEntry(log, "2026-10-11", "- **Update**: second");
    log = addLogEntry(log, "2026-10-11", "- **Update**: third");
    expect(log.indexOf("third")).toBeLessThan(log.indexOf("second"));
    expect(log.indexOf("## 2026-10-11")).toBeLessThan(log.indexOf("## 2026-10-10"));
    expect(checkLog(log)).toEqual([]);
    expect(() => addLogEntry(log, "Oct 11", "x")).toThrow();
  });

  it("flags non-date headings, wrong order, and dated bullets without groups", () => {
    const rules = (s: string) => checkLog(s).map((i) => i.rule);
    expect(rules("# L\n\n## 2026-07-12 (night) - title\n")).toContain("okf/log-date-heading");
    expect(rules("# L\n\n## 2026-07-01\n\n## 2026-07-02\n")).toContain("okf/log-order");
    expect(rules("# L\n\n- **2026-07-01** - x\n")).toContain("okf/log-date-heading");
  });

  it("converts a legacy newest-last log without changing a word of any entry", () => {
    const legacy = [
      "---",
      "type: log",
      "---",
      "",
      "# Bundle log",
      "",
      "- **2026-07-05** — Scaffolded.",
      "  Continuation line.",
      "",
      "## 2026-07-12 (night) — The dashboard is live",
      "",
      "Prose about the dashboard.",
      "",
      "- inner bullet, not an entry",
      "",
      "- **2026-07-12** — A later same-day bullet.",
      "",
      "## 2026-07-19 - Plain title",
      "",
      "More prose.",
    ].join("\n");
    const { text, entries, groups } = convertLegacyLog(legacy);
    expect(entries).toBe(4);
    expect(groups).toBe(3);
    expect(text.startsWith("# Bundle log")).toBe(true);
    expect(text.indexOf("## 2026-07-19")).toBeLessThan(text.indexOf("## 2026-07-12"));
    expect(text.indexOf("A later same-day bullet")).toBeLessThan(text.indexOf("### The dashboard is live (night)"));
    for (const words of ["Scaffolded.", "  Continuation line.", "Prose about the dashboard.", "- inner bullet, not an entry", "More prose."]) {
      expect(text).toContain(words);
    }
    expect(checkLog(text)).toEqual([]);
    // Idempotent on an already-converted log.
    expect(convertLegacyLog(text).text).toBe(text);
  });
});

describe("okf migrate - the mechanical half", () => {
  it("rewrites index, log, agent opt-ins, and default statuses; keeps YAML comments", () => {
    const root = migrateFile("index.md", '---\ntype: index\ntitle: "Acme index"\ndate: 2026-07-05\n---\n\nSee [log](log.md).\n');
    expect(root.text).toBe('---\nokf_version: "0.2"\n---\n\n# Acme index\n\nSee [log](log.md).\n');
    const agent = migrateFile("agents/cos.md", "---\ntype: agent\n# the cabinet, read-only\nsources: [onedrive]\nlevel: L1\n---\n\nJob.\n");
    expect(agent.text).toContain("# the cabinet, read-only\ncontext-sources: [onedrive]");
    const cal = migrateFile("ops/calendar.md", "---\ntype: calendar\nstatus: active\ndate: 2026-07-05\n---\n\n# C\n");
    expect(cal.text).not.toContain("status:");
    expect(cal.text).toContain("date: 2026-07-05");
  });

  it("reports judgment calls instead of guessing trust", () => {
    const fact = migrateFile(
      "facts/a.md",
      '---\ntype: fact\nstatus: verified\nverified-by: "session read of original, 2026-07-06"\nsources:\n  - a note\n---\n\nA.\n',
    );
    expect(fact.text).toContain("status: verified"); // untouched
    expect(fact.leftovers.map((l) => l.rule).sort()).toEqual(["provenance", "sources-shape", "status"]);
    // CRM `source:` is a domain key (how a relationship started), not provenance.
    expect(migrateFile("crm/p.md", "---\ntype: crm-person\nsource: linkedin\n---\n\nP.\n").leftovers).toEqual([]);
  });

  it("a migrated legacy bundle validates with no reserved-file or agent warnings", async () => {
    const files = new Map(
      Object.entries({
        "index.md": "---\ntype: index\ntitle: Brain\n---\n\n# Brain\n",
        "log.md": "---\ntype: log\n---\n\n# Log\n\n- **2026-07-05** — Scaffolded.\n",
        "constitution.md": concept("constitution", { immutable: true }, "# C"),
        "agents/a.md": "---\ntype: agent\nlevel: L1\nmodel: m\nharness: fake\nsources: [onedrive]\n---\n\nJob.\n",
      }),
    );
    const result = migrateBundle(files);
    const merged = Object.fromEntries([...files, ...result.files]);
    const report = checkConformance(await loadBundle(await tree(merged)), "animamesh");
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("the CLI dry-runs by default and writes with --write", async () => {
    const root = await tree({ ...minimalAnimaMeshFiles(), "ops/cal.md": concept("calendar", { status: "active" }, "# C") });
    const out: string[] = [];
    const io = { log: (s: string) => out.push(s), error: (s: string) => out.push(s) };
    expect(await main(["okf", "migrate", root], io)).toBe(0);
    expect(out.join("\n")).toMatch(/would change ops\/cal\.md/);
    expect(await readFile(path.join(root, "ops/cal.md"), "utf8")).toContain("status: active");
    expect(await main(["okf", "migrate", root, "--write"], io)).toBe(0);
    expect(await readFile(path.join(root, "ops/cal.md"), "utf8")).not.toContain("status:");
    out.length = 0;
    expect(await main(["okf", "trust", root], io)).toBe(0);
    expect(out.join("\n")).toMatch(/0 human-reviewed · 0 machine-confirmed · 2 unverified/);
  });
});

describe("the engine consumes v0.2", () => {
  it("agents read `context-sources:` and legacy string `sources:`, never provenance objects", () => {
    const a = (fm: Record<string, unknown>) =>
      agentFromConcept(fake({ type: "agent", level: "L1", model: "m", harness: "fake", ...fm }, "Job", "agents/a.md")).sources;
    expect(a({ "context-sources": ["onedrive"] })).toEqual(["onedrive"]);
    expect(a({ sources: ["gmail"] })).toEqual(["gmail"]);
    expect(a({ "context-sources": ["brains"], sources: [{ id: "x", resource: "https://x" }] })).toEqual(["brains"]);
  });

  it("the harness surfaces stale, draft, and deprecated knowledge - and stays silent otherwise", async () => {
    const bundle = await loadBundle(
      await tree({
        ...minimalOkfFiles(),
        "facts/old.md": concept("fact", { title: "Old fact", stale_after: "2026-01-01T00:00:00Z" }, "x"),
        "facts/wip.md": concept("fact", { status: "draft" }, "x"),
        "decisions/gone.md": concept("decision", { status: "deprecated", verified: "{ by: human:ada, at: 2026-01-01T00:00:00Z }" }, "x"),
      }),
    );
    const section = knowledgeTrustSection(bundle, new Date("2026-10-11T00:00:00Z"))!;
    expect(section).toContain("facts/old.md (Old fact)");
    expect(section).toMatch(/\*\*Draft\*\*[\s\S]*facts\/wip\.md/);
    expect(section).toMatch(/\*\*Deprecated\*\*[\s\S]*decisions\/gone\.md/);
    expect(section).toContain("1 human-reviewed");
    expect(trustDigest(bundle).total).toBe(3);
    const quiet = await loadBundle(await tree({ ...minimalOkfFiles(), "facts/a.md": concept("fact", {}, "x") }));
    expect(knowledgeTrustSection(quiet, new Date())).toBeNull();
  });

  it("the agent card takes the mesh title from the index H1 when the index has no frontmatter", async () => {
    const bundle = await loadBundle(await tree({ ...minimalOkfFiles(), "index.md": '---\nokf_version: "0.2"\n---\n\n# Acme brain\n' }));
    expect(buildAgentCardFromBundle(bundle, { bundle: "bundle" } as never).name).toContain("Acme brain");
  });
});
