import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { makeTree, concept } from "./helpers.js";
import { runAgent } from "../src/harness/run.js";
import { FakeProvider } from "../src/providers/fake.js";
import { agentFromConcept } from "../src/agents/concept.js";
import { parseConcept } from "../src/okf/frontmatter.js";
import { FsInstanceStore } from "../src/instance/store-fs.js";

/**
 * The issue #5 regression suite.
 *
 * An agent's role declared specific paths (a pipeline view, a CRM directory,
 * a drafts subdirectory of recurring working artifacts) as required reading
 * every run — in prose. On a no-tool harness the assembled context simply
 * lacked them: no placeholder, no signal, indistinguishable from the paths
 * not existing. The agent only detected the gap by cross-referencing its own
 * role text against what it was actually given.
 *
 * What must hold forever after: every path declared in `reads:` frontmatter
 * produces a visible section in the prompt — content, an explicit EMPTY
 * marker, or an explicit NOT AVAILABLE marker. "Nothing to report" and
 * "wasn't given the data" stay distinguishable facts.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function makeInstance(
  agentFrontmatter: Record<string, unknown>,
  extraFiles: Record<string, string> = {},
  job = "Coordinate the mesh.",
) {
  const files: Record<string, string> = {
    "animamesh.config.json": JSON.stringify({ bundle: "bundle" }, null, 2),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/agents/hub.md": concept(
      "agent",
      { name: "hub", title: "Hub", level: "L1", model: "test-model", harness: "fake", ...agentFrontmatter },
      job,
    ),
    ...extraFiles,
  };
  const root = await makeTree(files);
  roots.push(root);
  return root;
}

async function promptFor(root: string): Promise<string> {
  const provider = new FakeProvider();
  await runAgent({ instanceRoot: root, agentName: "hub", provider, runId: "run-reads" });
  return provider.calls[0]!.prompt;
}

describe("role-declared reads in the prompt (issue #5)", () => {
  it("inlines a declared bundle-relative file", async () => {
    const root = await makeInstance(
      { reads: ["ops/pipeline.md"] },
      { "bundle/ops/pipeline.md": "# Pipeline\n\n- row one: researched\n" },
    );
    const prompt = await promptFor(root);

    expect(prompt).toContain("## Role-declared context");
    expect(prompt).toContain("### ops/pipeline.md");
    expect(prompt).toContain("- row one: researched");
  });

  it("falls back to instance-root-relative paths — drafts live beside the bundle", async () => {
    const root = await makeInstance(
      { reads: ["drafts/prep/"] },
      { "drafts/prep/01-first.md": "pack one\n", "drafts/prep/02-second.md": "pack two\n" },
    );
    const prompt = await promptFor(root);

    expect(prompt).toContain("### drafts/prep/ (directory — 2 file(s))");
    expect(prompt).toContain("#### drafts/prep/01-first.md");
    expect(prompt).toContain("pack one");
    expect(prompt).toContain("pack two");
  });

  it("inlines a declared directory recursively, subdirs included", async () => {
    const root = await makeInstance(
      { reads: ["crm/"] },
      {
        "bundle/crm/taxonomy.md": concept("fact", {}, "# Taxonomy\n"),
        "bundle/crm/people/jane.md": concept("fact", {}, "# Jane\n"),
      },
    );
    const prompt = await promptFor(root);

    expect(prompt).toContain("### crm/ (directory — 2 file(s))");
    expect(prompt).toContain("#### crm/people/jane.md");
    expect(prompt).toContain("#### crm/taxonomy.md");
  });

  it("marks a missing declared path NOT AVAILABLE — the exact issue #5 shape, no more silent omission", async () => {
    const root = await makeInstance({ reads: ["ops/pipeline.md", "crm/"] });
    const prompt = await promptFor(root);

    expect(prompt).toContain("### ops/pipeline.md — DECLARED IN YOUR ROLE BUT NOT AVAILABLE THIS RUN");
    expect(prompt).toContain("### crm/ — DECLARED IN YOUR ROLE BUT NOT AVAILABLE THIS RUN");
    // And the framing tells the agent what the marker means.
    expect(prompt).toContain('never let it read as "nothing to report"');
  });

  it("marks an empty file EMPTY rather than dropping it", async () => {
    const root = await makeInstance({ reads: ["ops/pipeline.md"] }, { "bundle/ops/pipeline.md": "" });
    const prompt = await promptFor(root);

    expect(prompt).toContain("### ops/pipeline.md");
    expect(prompt).toContain("(file exists and is EMPTY)");
  });

  it("announces declared reads in the capability contract", async () => {
    const withReads = await makeInstance(
      { reads: ["ops/pipeline.md"] },
      { "bundle/ops/pipeline.md": "# Pipeline\n" },
    );
    expect(await promptFor(withReads)).toContain("**Declared reads: 1 path(s)**");

    const without = await makeInstance({});
    const prompt = await promptFor(without);
    expect(prompt).not.toContain("**Declared reads:");
    expect(prompt).not.toContain("## Role-declared context");
  });

  it("jails escaping paths instead of reading them", async () => {
    const root = await makeInstance({ reads: ["../secrets.md", "/etc/passwd"] });
    const prompt = await promptFor(root);

    expect(prompt).toContain("### ../secrets.md — INVALID PATH");
    expect(prompt).toContain("### /etc/passwd — INVALID PATH");
  });

  it("caps a large directory OUT LOUD — dropped files are named, never silently truncated", async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 23; i++) {
      files[`bundle/crm/rec-${String(i).padStart(2, "0")}.md`] = `record ${i}\n`;
    }
    const root = await makeInstance({ reads: ["crm/"] }, files);
    const prompt = await promptFor(root);

    expect(prompt).toContain("### crm/ (directory — 23 file(s))");
    expect(prompt).toContain("#### crm/rec-20.md");
    expect(prompt).not.toContain("#### crm/rec-21.md");
    expect(prompt).toContain("(3 more file(s) NOT inlined: rec-21.md, rec-22.md, rec-23.md)");
  });

  it("clips an oversized file with a visible truncation note", async () => {
    const root = await makeInstance(
      { reads: ["ops/pipeline.md"] },
      { "bundle/ops/pipeline.md": "x".repeat(9000) },
    );
    const prompt = await promptFor(root);

    expect(prompt).toContain("…(truncated by the harness)");
    expect(prompt).not.toContain("x".repeat(6001));
  });
});

describe("FsInstanceStore.listFiles", () => {
  it("lists markdown recursively as dir-relative POSIX paths, sorted; absent dir is empty", async () => {
    const root = await makeTree({
      "crm/taxonomy.md": "t",
      "crm/people/jane.md": "j",
      "crm/notes.txt": "not markdown",
      "animamesh.config.json": JSON.stringify({ bundle: "." }),
      "index.md": concept("index", {}, "# Index\n"),
      "log.md": concept("log", {}, "# Log\n"),
    });
    roots.push(root);
    const store = new FsInstanceStore(root);
    expect(await store.listFiles("crm")).toEqual(["people/jane.md", "taxonomy.md"]);
    expect(await store.listFiles("nope")).toEqual([]);
  });
});

describe("agent concept — the `reads:` declaration", () => {
  const parse = (fm: Record<string, unknown>) => {
    const raw = concept("agent", { name: "h", level: "L1", model: "m", harness: "fake", ...fm }, "job");
    const parsed = parseConcept(raw)!;
    return agentFromConcept({
      path: "agents/h.md",
      relPath: "agents/h.md",
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      missingFrontmatter: false,
    });
  };

  it("defaults to none — declared reads are opt-in", () => {
    expect(parse({}).reads).toEqual([]);
  });

  it("reads a string array, trimming entries", () => {
    expect(parse({ reads: ["ops/pipeline.md", " crm/ "] }).reads).toEqual(["ops/pipeline.md", "crm/"]);
  });

  it("drops nonsense rather than guessing", () => {
    expect(parse({ reads: "ops/pipeline.md" }).reads).toEqual([]);
    expect(parse({ reads: [42, "", "  ", null, "ok.md"] }).reads).toEqual(["ok.md"]);
  });
});
