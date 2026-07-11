import { describe, it, expect } from "vitest";
import { createMoonshotApiProvider } from "../src/providers/moonshot-api.js";
import { createAnthropicApiProvider } from "../src/providers/anthropic-api.js";
import { deliverMessage } from "../src/channels/registry.js";
import { runAgent } from "../src/harness/run.js";
import { makeTree, cleanup, concept, minimalAnimaMeshFiles } from "./helpers.js";

/**
 * LIVE seam tests — env-gated, skipped in `pnpm verify`. These prove the
 * real integrations (the parts mocks cannot vouch for) from the engine
 * checkout, using whatever env the operator sources first. From an instance:
 *
 *   set -a; source /path/to/your-instance/.env.local; set +a
 *   pnpm test:live          # runs every gate whose env flag is set
 *
 * Gates (opt-in, one per seam):
 *   LIVE_KIMI=1     — one real Moonshot/Kimi completion (MOONSHOT_API_KEY[,_BASE_URL])
 *   LIVE_DISCORD=1  — one real bot DM (DISCORD_BOT_TOKEN + DISCORD_DM_USER_ID)
 *   LIVE_AGENT=1    — a FULL agentic run: temp instance on disk → real Kimi
 *                     cognition → report artifact + ledger + verifiers green.
 *                     Touches no real instance; everything lands in a temp dir.
 *
 * (The GitHub seam has its own gate: GITHUB_STORE_IT=1 in
 * store-github-integration.test.ts, against a throwaway branch.)
 */

const env = process.env as Record<string, string | undefined>;

describe.skipIf(env.LIVE_KIMI !== "1")("live: moonshot-api provider", () => {
  it("completes a real request and returns text + token usage", async () => {
    const provider = createMoonshotApiProvider({ env });
    provider.assertConfigured();
    const result = await provider.run({
      prompt: "Reply with exactly one short sentence confirming you received this engine live-test.",
      cwd: process.cwd(),
      model: env.KIMI_MODEL ?? "kimi-for-coding",
    });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.tokens).toBeDefined();
  }, 120_000);
});

describe.skipIf(env.LIVE_CLAUDE !== "1")("live: anthropic-api provider (subscription OAuth)", () => {
  it("completes a real request over plain fetch", async () => {
    const provider = createAnthropicApiProvider({ env });
    provider.assertConfigured();
    const result = await provider.run({
      prompt: "Reply with exactly one short sentence confirming you received this engine live-test.",
      cwd: process.cwd(),
      model: "claude-haiku-4-5-20251001",
    });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.tokens).toBeDefined();
  }, 120_000);
});

describe.skipIf(env.LIVE_DISCORD !== "1")("live: discord channel", () => {
  it("delivers a bot DM to the configured principal", async () => {
    const results = await deliverMessage(
      {
        title: "engine live-test ping",
        body: `🧪 anima-mesh \`pnpm test:live\` — discord seam OK at ${new Date().toISOString()}`,
      },
      ["discord"],
      { env },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
  }, 60_000);
});

describe.skipIf(env.LIVE_AGENT !== "1")("live: full agentic run, locally end to end", () => {
  it("scaffolds a temp instance, runs a real Kimi agent, verifiers green", async () => {
    const root = await makeTree({
      "animamesh.config.json": JSON.stringify({ bundle: "bundle" }),
      "bundle/index.md": concept("index", { title: "Live Test Mesh" }, "# Index\n"),
      "bundle/log.md": concept("log", {}, "# Log\n"),
      "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
      "bundle/ops/calendar.md": concept("calendar", {}, "# Calendar\n\n- nothing scheduled\n"),
      "bundle/agents/probe.md": concept(
        "agent",
        { name: "probe", title: "Probe", level: "L1", model: env.KIMI_MODEL ?? "kimi-for-coding", harness: "moonshot-api" },
        "You are a live-test probe. Report, in three sentences or fewer, that the mesh's cognition seam works.",
      ),
      "ledger/actions.jsonl": "",
    });
    try {
      const report = await runAgent({
        instanceRoot: root,
        agentName: "probe",
        providerCtx: { env },
      });
      expect(report.ok).toBe(true);
      expect(report.text.length).toBeGreaterThan(0);
      for (const v of report.verifierResults) expect(v.ok).toBe(true);
    } finally {
      await cleanup(root);
    }
  }, 300_000);
});
