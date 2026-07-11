import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { makeTree, concept } from "./helpers.js";
import { runAgent } from "../src/harness/run.js";
import { heartbeat } from "../src/harness/heartbeat.js";
import { runDirectionCore } from "../src/harness/direction-core.js";
import { FsInstanceStore } from "../src/instance/store-fs.js";
import { FakeProvider } from "../src/providers/fake.js";
import { registerProvider } from "../src/providers/index.js";

/**
 * cognition.overrides — the "which brain, today" knob (founder ask,
 * 2026-07-11): agent frontmatter keeps its DECLARED harness/model (the
 * hoped-for vendor, e.g. kimi), while instance config redirects it at run
 * time (e.g. to anthropic-api while the Kimi edge blocks Workers). Delete
 * the override to fall back. Evidence must record what ACTUALLY ran.
 */

const roots: string[] = [];
afterEach(async () => {
  registerProvider(new FakeProvider(), "fake");
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function makeInstance(config: Record<string, unknown>, agentExtra: Record<string, unknown> = {}) {
  const root = await makeTree({
    "animamesh.config.json": JSON.stringify({ bundle: "bundle", ...config }),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/agents/scout.md": concept(
      "agent",
      { name: "scout", title: "Scout", level: "L1", model: "kimi-for-coding", harness: "moonshot-api", heartbeat: "daily", ...agentExtra },
      "Scout things.",
    ),
    "ledger/actions.jsonl": "",
  });
  roots.push(root);
  return root;
}

const OVERRIDE = { cognition: { overrides: { "moonshot-api": { harness: "fake", model: "substitute-model" } } } };

describe("cognition.overrides", () => {
  it("redirects the declared harness+model; evidence records what actually ran", async () => {
    const root = await makeInstance(OVERRIDE);
    const fake = new FakeProvider(() => ({ text: "override ran" }));
    registerProvider(fake, "fake");

    const report = await runAgent({ instanceRoot: root, agentName: "scout" });

    expect(report.ok).toBe(true);
    expect(report.harness).toBe("fake"); // effective, not declared
    expect(report.model).toBe("substitute-model");
    expect(fake.calls[0]!.model).toBe("substitute-model");
    const artifact = await readFile(report.reportPath, "utf8");
    expect(artifact).toContain("harness: fake");
    expect(artifact).toContain("model: substitute-model");
    expect(artifact).not.toContain("kimi-for-coding");
  });

  it("no override for the declared harness → the declaration stands", async () => {
    // NB: overriding onto a contextual harness (moonshot-api/anthropic-api)
    // can't be faked via the registry — the ctx factory wins — so these
    // semantics are tested on the fake harness.
    const root = await makeInstance(
      { cognition: { overrides: { "some-other-harness": { harness: "moonshot-api" } } } },
      { harness: "fake", model: "declared-model" },
    );
    const fake = new FakeProvider(() => ({ text: "x" }));
    registerProvider(fake, "fake");
    const report = await runAgent({ instanceRoot: root, agentName: "scout" });
    expect(report.harness).toBe("fake");
    expect(report.model).toBe("declared-model");
    expect(fake.calls[0]!.model).toBe("declared-model");
  });

  it("a partial override (model only) keeps the declared harness", async () => {
    const root = await makeInstance(
      { cognition: { overrides: { fake: { model: "swapped-model" } } } },
      { harness: "fake", model: "declared-model" },
    );
    const fake = new FakeProvider(() => ({ text: "x" }));
    registerProvider(fake, "fake");
    const report = await runAgent({ instanceRoot: root, agentName: "scout" });
    expect(report.harness).toBe("fake");
    expect(report.model).toBe("swapped-model");
    expect(fake.calls[0]!.model).toBe("swapped-model");
  });

  it("the cloud gate judges the EFFECTIVE harness, both directions", async () => {
    // Declared laptop-tier, overridden to a cloud harness → due in the cloud.
    const toCloud = await makeInstance({
      cognition: { overrides: { "claude-code": { harness: "anthropic-api", model: "claude-sonnet-5" } } },
    }, { harness: "claude-code", model: "sonnet" });
    const up = await heartbeat({ instanceRoot: toCloud, cloudTier: true, dryRun: true });
    expect(up.due.map((d) => d.agent)).toEqual(["scout"]);

    // Declared cloud-capable, overridden to a subprocess harness → honestly skipped.
    const toLaptop = await makeInstance({
      cognition: { overrides: { "moonshot-api": { harness: "claude-code" } } },
    });
    const down = await heartbeat({ instanceRoot: toLaptop, cloudTier: true, dryRun: true });
    expect(down.due).toEqual([]);
    expect(down.skipped[0]!.reason).toContain("laptop-tier harness (claude-code)");
  });

  it("directions honor the override too — one knob for every entry point", async () => {
    const root = await makeInstance({ ...OVERRIDE, direction: { agent: "scout" } });
    const fake = new FakeProvider(() => ({ text: "directed via override" }));
    registerProvider(fake, "fake");

    const report = await runDirectionCore({
      store: new FsInstanceStore(root),
      message: { channel: "discord", sender: "p", text: "hi", receivedAt: new Date().toISOString() },
    });
    expect(report.harness).toBe("fake");
    expect(report.model).toBe("substitute-model");
    expect(report.reply).toBe("directed via override");
  });
});
