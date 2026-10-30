import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { makeTree, concept } from "./helpers.js";
import { scaffoldBrain, localAgentText } from "../src/init/scaffold.js";
import { deliverLatestReport } from "../src/channels/index.js";
import { sourceSections } from "../src/sources/registry.js";
import { localModeIssues, LocalModeViolation } from "../src/instance/local-mode.js";
import { runAgent } from "../src/harness/run.js";
import { heartbeat } from "../src/harness/heartbeat.js";
import { FakeProvider } from "../src/providers/fake.js";
import { DEFAULT_CONFIG, type InstanceConfig } from "../src/instance/config-core.js";

/**
 * Local mode (v2.3.6): a brain whose knowledge never leaves the machine.
 * Every refusal below is enforced in code at the point the capability
 * would act - none of it depends on a prompt.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

/** A fetch that fails the test if anything tries to reach the network. */
const noNetwork = (async (url: unknown) => {
  throw new Error(`network call attempted in local mode: ${String(url)}`);
}) as typeof fetch;

const LOCAL: InstanceConfig = { ...DEFAULT_CONFIG, mode: "local" };

async function localInstance(extra: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const root = await makeTree({
    "animamesh.config.json": JSON.stringify({ bundle: "bundle", mode: "local", delivery: { channels: ["console"] }, ...config }),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "ledger/actions.jsonl": "",
    ...extra,
  });
  roots.push(root);
  return root;
}

describe("init --local", () => {
  it("scaffolds a conformant brain that is local by config, with the standards pack and no network sources", async () => {
    const root = path.join(tmpdir(), `am-local-${Date.now()}`);
    roots.push(root);
    const result = await scaffoldBrain(root, {
      orgName: "Acme Advisory",
      principalName: "Sam Lee",
      brainKind: "person",
      agents: [],
      localOnly: true,
      now: "2026-10-27T12:00:00Z",
    });
    expect(result.conformance.ok).toBe(true);
    const config = JSON.parse(await readFile(path.join(root, "animamesh.config.json"), "utf8"));
    expect(config.mode).toBe("local");
    expect(config.delivery.channels).toEqual(["console"]);
    expect(localModeIssues(config)).toEqual([]);

    const claude = await readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(claude).toContain("## Local mode: nothing leaves this machine");
    expect(claude).toContain("bundle/ops/focus.md");
    expect(existsSync(path.join(root, "AGENTS.md"))).toBe(true);

    for (const f of (await readdir(path.join(root, "bundle/agents"))).filter((n) => n !== "index.md")) {
      const text = await readFile(path.join(root, "bundle/agents", f), "utf8");
      expect(text).not.toMatch(/gmail|google-calendar|google-drive|onedrive/);
      expect(text).not.toMatch(/^web:\s*\d/m);
      expect(text).toMatch(/harness: "claude-code"/);
    }
    expect(await readFile(path.join(root, "bundle/ops/engine-feedback.md"), "utf8")).toContain("never files issues");
  });

  it("a non-local init gets the standards pack too, without the local section", async () => {
    const root = path.join(tmpdir(), `am-std-${Date.now()}`);
    roots.push(root);
    await scaffoldBrain(root, { orgName: "Acme", principalName: "Sam Lee", agents: [], now: "2026-10-27T12:00:00Z" });
    const claude = await readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(claude).toContain("## Writing memory (OKF v0.2)");
    expect(claude).toContain("## One brain, everything in it");
    expect(claude).not.toContain("Local mode");
  });

  it("strips network sources and the web budget from an agent's frontmatter only", () => {
    const text = "---\ntype: agent\n# context for a life\n# connect google first\ncontext-sources: [brains, gmail, google-drive]\n# budget\nweb: 4\n---\n\nUse gmail wisely.\n";
    const out = localAgentText(text);
    expect(out).toContain("context-sources: [brains]");
    expect(out).not.toContain("connect google");
    expect(out).not.toMatch(/^web: 4/m);
    expect(out).toContain("Use gmail wisely."); // the body is untouched
  });
});

describe("validate flags a local-mode config that reaches out", () => {
  it("errors on chat delivery, remote-only links, and inbound mail", () => {
    const rules = localModeIssues({
      ...LOCAL,
      delivery: { channels: ["console", "slack"] },
      links: [{ id: "co", relation: "member-of", repo: "o/co" }],
      direction: { gmail: { pollMinutes: 5 } },
    } as InstanceConfig).map((i) => [i.level, i.rule]);
    expect(rules).toEqual([["error", "local/delivery"], ["error", "local/links"], ["error", "local/gmail"]]);
    expect(localModeIssues({ ...DEFAULT_CONFIG, delivery: { channels: ["slack"] } })).toEqual([]);
  });
});

describe("the engine refuses network reach for a local-mode brain", () => {
  it("delivery to any channel but the console throws before any network call", async () => {
    const root = await localInstance({ "reports/2026-10-27-chief-of-staff-aaaa.md": "# Brief\n\n## Brief\nAll quiet.\n" });
    await expect(deliverLatestReport(root, { channels: ["slack"], fetchImpl: noNetwork })).rejects.toThrow(LocalModeViolation);
    const lines: string[] = [];
    await deliverLatestReport(root, { log: (s) => lines.push(s) });
    expect(lines.join("\n")).toContain("All quiet.");
  });

  it("network read sources, and the docs corpus without a local path, are reported off and never fetched", async () => {
    const ctx = { env: {}, fetchImpl: noNetwork, config: LOCAL };
    const sections = await sourceSections(["gmail", "google-calendar", "google-drive", "onedrive", "github-docs"], ctx);
    expect(sections).toHaveLength(5);
    for (const s of sections) expect(s).toContain("this brain runs in local mode");
  });

  it("web search is off even when the agent asks and the harness could", async () => {
    const root = await localInstance({
      "bundle/agents/watch.md": concept("agent", { name: "watch", title: "Watch", level: "L1", model: "m", harness: "fake", web: 5 }, "Watch."),
    });
    const provider = new FakeProvider(undefined, { fileReads: false, webSearch: true });
    await runAgent({ instanceRoot: root, agentName: "watch", provider, runId: "run-web" });
    expect(provider.calls[0]!.webSearchMaxUses).toBeUndefined();
    expect(provider.calls[0]!.prompt).toContain("Web search: NO, this brain runs in local mode");
  });

  it("an engine defect stays a draft even with a filing token present", async () => {
    const root = await localInstance(
      {
        "bundle/agents/hub.md": concept(
          "agent",
          { name: "hub", title: "Hub", level: "L3", model: "m", harness: "fake", whitelist: ["defect-report"] },
          "Coordinate.",
        ),
      },
      { engine: { repo: "github.com/example/engine" } },
    );
    const provider = new FakeProvider(() => ({ text: "Report.\n\n```defect-report\ntitle: Harness drops the schedule\n---\nRepro: an empty schedule.\n```\n" }));
    await runAgent({
      instanceRoot: root,
      agentName: "hub",
      provider,
      runId: "run-defect",
      providerCtx: { env: { GITHUB_DEFECTS_TOKEN: "ghp_test" }, fetchImpl: noNetwork },
    });
    const drafts = await readdir(path.join(root, "drafts/defects"));
    expect(drafts.length).toBe(1);
  });

  it("the cloud tier refuses a local-mode brain outright", async () => {
    const root = await localInstance();
    await expect(heartbeat({ instanceRoot: root, cloudTier: true, dryRun: true })).rejects.toThrow(/the cloud tier is off/);
  });
});

describe("the focus links out: Top-of-mind records reach the hub", () => {
  const focus = concept(
    "focus",
    { title: "Focus", date: "2026-10-27", stale_after: "2099-01-01T00:00:00Z" },
    "# Focus\n\n## Top of mind\n- [The return](../finance/return.md) is due.\n- [A ghost](../finance/ghost.md).\n\n## Secondary\n- [Lunch](../life/lunch.md).\n",
  );
  async function promptFor(agentName: string) {
    const root = await localInstance({
      "bundle/ops/focus.md": focus,
      "bundle/finance/return.md": concept("fact", { title: "Return" }, "# Return\n\nForm due March 1; preparer chosen.\n"),
      "bundle/life/lunch.md": concept("fact", { title: "Lunch" }, "# Lunch\n\nNoodles.\n"),
      "bundle/agents/chief-of-staff.md": concept("agent", { name: "chief-of-staff", title: "Hub", level: "L1", model: "m", harness: "fake" }, "Brief."),
      "bundle/agents/spoke.md": concept("agent", { name: "spoke", title: "Spoke", level: "L1", model: "m", harness: "fake" }, "Work."),
    });
    const provider = new FakeProvider();
    await runAgent({ instanceRoot: root, agentName, provider, runId: `run-${agentName}` });
    return provider.calls[0]!.prompt;
  }

  it("inlines Top-of-mind records for the hub, says when a link is missing, and leaves secondary links alone", async () => {
    const prompt = await promptFor("chief-of-staff");
    expect(prompt).toContain("### Records linked from Top of mind");
    expect(prompt).toContain("Form due March 1; preparer chosen.");
    expect(prompt).toContain("finance/ghost.md - LINKED FROM THE FOCUS BUT NOT FOUND");
    expect(prompt).not.toContain("Noodles.");
  });

  it("spokes get the focus but not the linked records", async () => {
    const prompt = await promptFor("spoke");
    expect(prompt).toContain("### ops/focus.md - the principal's priorities");
    expect(prompt).not.toContain("Form due March 1");
  });
});
