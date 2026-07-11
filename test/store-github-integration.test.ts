import { describe, it, expect } from "vitest";
import { GitHubInstanceStore } from "../src/instance/store-github.js";

/**
 * Env-gated integration test against a REAL repo — skipped unless
 * GITHUB_STORE_IT=1 (and GITHUB_TOKEN / GITHUB_STORE_REPO set). Points at a
 * throwaway branch (default cloud-seam-test); never main. Writes one marker
 * report and asserts the flush commit lands. The branch is periodically
 * reset by hand — no cleanup here (cleanup would just be another commit).
 */
const enabled = process.env.GITHUB_STORE_IT === "1";

describe.skipIf(!enabled)("GitHubInstanceStore (live)", () => {
  it("reads the bundle and lands one commit on the test branch", async () => {
    const repo = process.env.GITHUB_STORE_REPO;
    const token = process.env.GITHUB_TOKEN;
    if (!repo || !token) throw new Error("set GITHUB_STORE_REPO and GITHUB_TOKEN");

    const store = new GitHubInstanceStore({
      repo,
      ref: process.env.GITHUB_STORE_REF ?? "cloud-seam-test",
      token,
    });

    const bundle = await store.loadBundle();
    expect(bundle.concepts.length).toBeGreaterThan(0);

    const marker = `it-${Date.now()}.md`;
    await store.writeReport(marker, `integration marker ${new Date().toISOString()}\n`);
    expect(await store.readReport(marker)).toContain("integration marker");

    const { commitSha } = await store.flush(`test(store): integration marker ${marker}`);
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);
});
