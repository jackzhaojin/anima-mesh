import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { isoDateName, isoDatePath, planIsoDates, rewriteReferences, compactMentions } from "../src/okf/iso-dates.js";
import { loadBundle } from "../src/okf/bundle.js";
import { checkConformance } from "../src/okf/conformance.js";
import { main } from "../src/cli.js";
import { makeTree, cleanup, concept, minimalAnimaMeshFiles } from "./helpers.js";

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTree(files);
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) await cleanup(roots.pop()!);
});

const decision = (date: string, body = "# D") => concept("decision", { date, stage: "accepted" }, body);
const event = (date: string, body = "# E") => concept("event", { date }, body);

describe("isoDateName", () => {
  it("rewrites a leading compact date and keeps the rest", () => {
    expect(isoDateName("20261030-one-brain.md")).toBe("2026-10-30-one-brain.md");
    expect(isoDateName("20260901-partner-program-2026-2027")).toBe("2026-09-01-partner-program-2026-2027");
    expect(isoDateName("20261030")).toBe("2026-10-30");
    expect(isoDateName("20261030.md")).toBe("2026-10-30.md");
  });

  it("leaves ISO names, non-dates and impossible dates alone", () => {
    expect(isoDateName("2026-10-30-one-brain.md")).toBeNull();
    expect(isoDateName("12345678-ticket.md")).toBeNull();
    expect(isoDateName("20261332-x.md")).toBeNull();
    expect(isoDateName("20260230-x.md")).toBeNull();
    expect(isoDateName("202610301-x.md")).toBeNull();
    expect(isoDateName("fy2026.md")).toBeNull();
  });

  it("maps every dated segment of a path", () => {
    expect(isoDatePath("professional/2026/20260901-program/20260908-kit.md")).toBe(
      "professional/2026/2026-09-01-program/2026-09-08-kit.md",
    );
  });
});

describe("rewriteReferences", () => {
  const tokens = new Map([
    ["20261018-issue-filing", "2026-10-18-issue-filing"],
    ["20261018-issue", "2026-10-18-issue"],
  ]);

  it("rewrites links, backticked paths and frontmatter resources, whole tokens only", () => {
    const text = [
      "[filing](../decisions/2026/20261018-issue-filing.md)",
      "`decisions/2026/20261018-issue.md`",
      '  - { id: x, resource: "../decisions/2026/20261018-issue-filing.md" }',
      "see 20261018-issue-filing-v2 and x20261018-issue",
    ].join("\n");
    const { text: out, count } = rewriteReferences(text, tokens);
    expect(count).toBe(3);
    expect(out).toContain("(../decisions/2026/2026-10-18-issue-filing.md)");
    expect(out).toContain("`decisions/2026/2026-10-18-issue.md`");
    expect(out).toContain('resource: "../decisions/2026/2026-10-18-issue-filing.md"');
    expect(out).toContain("see 20261018-issue-filing-v2 and x20261018-issue");
  });

  it("never touches a number that is not a renamed name", () => {
    const { text, count } = rewriteReferences("member 20261018, touch -t 202610181200.00", tokens);
    expect(count).toBe(0);
    expect(text).toBe("member 20261018, touch -t 202610181200.00");
  });

  it("rewrites a bare-date folder only where it sits in a path", () => {
    const bare = new Map([["20261018", "2026-10-18"]]);
    const { text, count } = rewriteReferences("notes/20261018/a.md and ref 20261018", bare);
    expect(count).toBe(1);
    expect(text).toBe("notes/2026-10-18/a.md and ref 20261018");
  });

  it("finds compact dated mentions that are left", () => {
    expect(compactMentions("see 20261018-other-brain and 12345678-x and 2026-10-18-done")).toEqual(["20261018-other-brain"]);
  });
});

describe("planIsoDates", () => {
  it("plans renames, rewrites and leftovers without touching the ledger", () => {
    const texts = new Map([
      ["bundle/index.md", "[d](decisions/2026/20261030-one-brain.md) and [[20260101-gone]]"],
      ["reports/2026-11-01-hub.md", "read bundle/decisions/2026/20261030-one-brain.md"],
    ]);
    const plan = planIsoDates(["bundle/decisions/2026/20261030-one-brain.md", "bundle/index.md", "reports/2026-11-01-hub.md"], texts);
    expect(plan.renames).toEqual([
      { from: "bundle/decisions/2026/20261030-one-brain.md", to: "bundle/decisions/2026/2026-10-30-one-brain.md" },
    ]);
    expect(plan.clashes).toEqual([]);
    expect(plan.counts.get("bundle/index.md")).toBe(1);
    expect(plan.counts.get("reports/2026-11-01-hub.md")).toBe(1);
    expect(plan.unresolved).toEqual([{ path: "bundle/index.md", name: "20260101-gone" }]);
  });

  it("refuses a rename whose ISO name already exists", () => {
    const plan = planIsoDates(["a/20261030-x.md", "a/2026-10-30-x.md"], new Map());
    expect(plan.clashes).toEqual([{ from: "a/20261030-x.md", to: "a/2026-10-30-x.md" }]);
    expect(plan.renames).toEqual([]);
  });
});

describe("conformance", () => {
  it("warns on compact dated names and passes clean on ISO ones", async () => {
    const old = checkConformance(
      await loadBundle(await tree({ ...minimalAnimaMeshFiles(), "decisions/2026/20261030-x.md": decision("2026-10-30") })),
      "animamesh",
    );
    expect(old.issues.map((i) => i.rule)).toContain("animamesh/iso-date-name");
    const iso = checkConformance(
      await loadBundle(await tree({ ...minimalAnimaMeshFiles(), "decisions/2026/2026-10-30-x.md": decision("2026-10-30") })),
      "animamesh",
    );
    expect(iso.issues).toEqual([]);
  });
});

describe("okf iso-dates CLI", () => {
  it("dry-runs by default, then renames, rewrites links, logs and passes conformance", async () => {
    const root = await tree({
      ...minimalAnimaMeshFiles(),
      "index.md": '---\nokf_version: "0.2"\n---\n\n# Index\n\n- [decisions](decisions/2026/20261030-x.md)\n- [kit](work/2026/20260901-program/20260908-kit.md)\n',
      "decisions/2026/20261030-x.md": decision("2026-10-30", "# D\n\nSee [the event](../../events/2026/20261029-y.md)."),
      "events/2026/20261029-y.md": event("2026-10-29"),
      "work/2026/20260901-program/20260908-kit.md": concept("note", { date: "2026-09-08" }, "# Kit"),
      "work/2026/20260901-program/20260908-photo.webp": "binary-ish",
      "ledger/actions.jsonl": '{"detail":{"path":"decisions/2026/20261030-x.md"}}\n',
    });
    const out: string[] = [];
    const io = { log: (s: string) => out.push(s), error: (s: string) => out.push(s) };

    expect(await main(["okf", "iso-dates", root], io)).toBe(0);
    expect(out.join("\n")).toMatch(/would rename decisions\/2026\/20261030-x\.md -> decisions\/2026\/2026-10-30-x\.md/);
    expect(existsSync(path.join(root, "decisions/2026/20261030-x.md"))).toBe(true);

    out.length = 0;
    expect(await main(["okf", "iso-dates", root, "--write"], io)).toBe(0);
    expect(existsSync(path.join(root, "decisions/2026/20261030-x.md"))).toBe(false);
    expect(existsSync(path.join(root, "work/2026/20260901-program"))).toBe(false);
    expect(existsSync(path.join(root, "work/2026/2026-09-01-program/2026-09-08-photo.webp"))).toBe(true);
    expect(await readFile(path.join(root, "decisions/2026/2026-10-30-x.md"), "utf8")).toContain("events/2026/2026-10-29-y.md");
    const index = await readFile(path.join(root, "index.md"), "utf8");
    expect(index).toContain("work/2026/2026-09-01-program/2026-09-08-kit.md");
    expect(await readFile(path.join(root, "log.md"), "utf8")).toMatch(/### Dated names to ISO 8601\n\n4 file\(s\) renamed/);
    // The ledger is append-only: never rewritten.
    expect(await readFile(path.join(root, "ledger/actions.jsonl"), "utf8")).toContain("20261030-x.md");

    const report = checkConformance(await loadBundle(root), "animamesh");
    expect(report.issues.filter((i) => i.rule === "animamesh/iso-date-name")).toEqual([]);

    out.length = 0;
    expect(await main(["okf", "iso-dates", root, "--write"], io)).toBe(0);
    expect(out.join("\n")).toMatch(/0 file\(s\) renamed/);
  });
});
