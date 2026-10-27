import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import * as path from "node:path";
import { makeTree, concept } from "./helpers.js";
import { digestBrief } from "../src/channels/brief-core.js";
import { deliverLatestReport } from "../src/channels/index.js";
import { slackChannel } from "../src/channels/slack.js";
import { briefSettingsFrom, focusIsStale, parseFocusUpdate, stripFocusUpdates } from "../src/harness/focus.js";
import { runAgent } from "../src/harness/run.js";
import { runDirectionCore, type DirectionMessage } from "../src/harness/direction-core.js";
import { FsInstanceStore } from "../src/instance/store-fs.js";
import { FakeProvider } from "../src/providers/fake.js";

/**
 * Focus and the brief digest (v2.3.5). What must hold:
 * - the notification is the hub's `## Brief`, cut to N lines IN CODE; the
 *   thread holds a capped Also list and a link; the rest never leaves git
 * - a report that ignores the format is still short, and flagged
 * - every agent reads the focus first; only the hub gets the brief format
 * - only the principal moves the focus, and only from a direction
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

const REPORT = [
  "# Daily brief: 2026-10-27",
  "",
  "## Brief",
  "Franchise tax is due Mar 1; file by Feb 20?",
  "The webinar deck needs your review by Fri.",
  "Nothing else needs you.",
  "A fourth line the hub should not have written.",
  "",
  "## Also",
  ...Array.from({ length: 10 }, (_, i) => `- P3 · misc: item ${i + 1}`),
  "",
  "## Detail",
  "Pages of evidence nobody reads on a phone.",
].join("\n");

describe("digestBrief", () => {
  it("cuts the notification to the configured lines, threads the overflow and a capped Also list", () => {
    const d = digestBrief(REPORT, { lines: 3, also: 5 }, "https://github.com/o/b/blob/main/reports/x.md");
    expect(d.followedFormat).toBe(true);
    expect(d.headline.split("\n")).toEqual([
      "Franchise tax is due Mar 1; file by Feb 20?",
      "The webinar deck needs your review by Fri.",
      "Nothing else needs you.",
    ]);
    expect(d.thread).toContain("- A fourth line the hub should not have written.");
    expect(d.thread).toContain("- P3 · misc: item 4");
    expect(d.thread).not.toContain("item 5");
    expect(d.thread).toContain("...and 6 more in the full report.");
    expect(d.thread).toContain("Full report: https://github.com/o/b/blob/main/reports/x.md");
    expect(d.headline + d.thread).not.toContain("Pages of evidence");
  });

  it("a report without ## Brief is still short, and flagged", () => {
    const long = "# Brief\n\n## Active nags\n\n" + Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const d = digestBrief(long, { lines: 3, also: 8 }, "reports/x.md");
    expect(d.followedFormat).toBe(false);
    expect(d.headline).toBe("line 0\nline 1\nline 2");
    expect(d.thread).toContain("no `## Brief` section");
    expect(d.thread).not.toContain("line 3");
  });

  it("reads brief settings from the focus frontmatter, clamped", () => {
    expect(briefSettingsFrom(undefined)).toEqual({ lines: 3, also: 8 });
    expect(briefSettingsFrom({ brief: { lines: 2, also: 4 } })).toEqual({ lines: 2, also: 4 });
    expect(briefSettingsFrom({ brief: { lines: 99, also: -3 } })).toEqual({ lines: 10, also: 0 });
  });

  it("a focus past stale_after, or undated, is stale", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const f = (frontmatter: Record<string, unknown>) => ({ raw: "", body: "", frontmatter, brief: { lines: 3, also: 8 } });
    expect(focusIsStale(f({ stale_after: "2026-11-01T00:00:00Z" }), now)).toBe(false);
    expect(focusIsStale(f({ stale_after: "2026-10-01T00:00:00Z" }), now)).toBe(true);
    expect(focusIsStale(f({ date: "2026-10-20" }), now)).toBe(false);
    expect(focusIsStale(f({}), now)).toBe(true);
  });
});

const FOCUS = concept(
  "focus",
  { title: "Focus", date: "2026-10-27", stale_after: "2099-01-01T00:00:00Z", brief: { lines: 2, also: 3 } },
  "# Focus\n\n## Top of mind\n- Taxes.\n\n## Quiet (silent unless the exception fires)\n- CRM - unless a lawsuit.\n\n## Hands off\n- Selling the condo: another session owns it.\n",
);

async function makeInstance(extra: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const agent = (name: string, whitelist: string[] = []) =>
    concept("agent", { name, title: name, level: "L3", model: "m", harness: "fake", heartbeat: "daily", whitelist }, "Do the job.");
  const root = await makeTree({
    "animamesh.config.json": JSON.stringify({ bundle: "bundle", delivery: { channels: ["console"] }, ...config }),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/agents/chief-of-staff.md": agent("chief-of-staff", ["focus-update"]),
    "bundle/agents/spoke.md": agent("spoke"),
    "ledger/actions.jsonl": "",
    ...extra,
  });
  roots.push(root);
  return root;
}

describe("delivery sends the digest, never the pages", () => {
  it("the hub's newest report goes out as its brief lines plus a thread, by the focus's line counts", async () => {
    const root = await makeInstance({ "bundle/ops/focus.md": FOCUS, "reports/2026-10-27-chief-of-staff-aaaa.md": REPORT });
    const lines: string[] = [];
    await deliverLatestReport(root, { log: (s) => lines.push(s) });
    const out = lines.join("\n");
    expect(out).toContain("Franchise tax is due Mar 1");
    expect(out).toContain("The webinar deck needs your review");
    expect(out).toContain("- Nothing else needs you."); // past 2 lines: threaded
    expect(out).toContain("...and 9 more in the full report.");
    expect(out).toContain(`Full report: ${path.join(root, "reports", "2026-10-27-chief-of-staff-aaaa.md")}`);
    expect(out).not.toContain("Pages of evidence");
  });

  it('`delivery.format: "full"` keeps the whole report', async () => {
    const root = await makeInstance({ "reports/2026-10-27-chief-of-staff-aaaa.md": REPORT }, { delivery: { channels: ["console"], format: "full" } });
    const lines: string[] = [];
    await deliverLatestReport(root, { log: (s) => lines.push(s) });
    expect(lines.join("\n")).toContain("Pages of evidence");
  });

  it("slack bot mode posts the brief bare, then the thread as a reply under it", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const impl = (async (_url: unknown, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1700.0001" }), text: async () => "" } as Response;
    }) as typeof fetch;
    await slackChannel.deliver(
      { title: "Daily brief", body: "Line one.\nLine two.", thread: "- P2 · ops: x\n\nFull report: r.md" },
      { env: { SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL_ID: "CTEAM" }, fetchImpl: impl },
    );
    expect(calls).toHaveLength(2);
    expect((calls[0]!.blocks as Array<{ text: string }>)[0]!.text).toBe("Line one.\nLine two.");
    expect(calls[0]!.thread_ts).toBeUndefined();
    expect(calls[1]!.thread_ts).toBe("1700.0001");
    expect((calls[1]!.blocks as Array<{ text: string }>)[0]!.text).toContain("Full report: r.md");
  });
});

describe("every agent reads the focus first; the hub gets the brief format", () => {
  async function promptFor(root: string, agentName: string): Promise<string> {
    const provider = new FakeProvider();
    await runAgent({ instanceRoot: root, agentName, provider, runId: `run-${agentName}` });
    return provider.calls[0]!.prompt;
  }

  it("inlines ops/focus.md ahead of the index, for spokes and the hub alike", async () => {
    const root = await makeInstance({ "bundle/ops/focus.md": FOCUS });
    for (const name of ["spoke", "chief-of-staff"]) {
      const prompt = await promptFor(root, name);
      const focusAt = prompt.indexOf("### ops/focus.md - the principal's priorities");
      expect(focusAt).toBeGreaterThan(-1);
      expect(focusAt).toBeLessThan(prompt.indexOf("### index.md"));
      expect(prompt).toContain("Selling the condo: another session owns it.");
    }
  });

  it("only the hub is told the brief format, with the focus's line counts", async () => {
    const root = await makeInstance({ "bundle/ops/focus.md": FOCUS });
    const hub = await promptFor(root, "chief-of-staff");
    expect(hub).toContain("## Report format: the brief");
    expect(hub).toContain("`## Brief` - at most 2 line(s)");
    expect(hub).toContain("at most 3 one-line items");
    expect(await promptFor(root, "spoke")).not.toContain("## Report format: the brief");
  });

  it("with no focus, the hub is told to ask the principal for one", async () => {
    const root = await makeInstance();
    expect(await promptFor(root, "chief-of-staff")).toContain("Make one Also line ask the\nprincipal to set their focus");
  });

  it("a focus-update block in a scheduled run is ignored: the mesh never moves its own dial", async () => {
    const root = await makeInstance({ "bundle/ops/focus.md": FOCUS });
    const provider = new FakeProvider(() => ({ text: "## Brief\nAll quiet.\n\n```focus-update\n# Focus\n## Top of mind\n- Sell everything.\n```\n" }));
    await runAgent({ instanceRoot: root, agentName: "chief-of-staff", provider, runId: "run-beat" });
    expect(await readFile(path.join(root, "bundle/ops/focus.md"), "utf8")).not.toContain("Sell everything");
  });
});

describe("only the principal moves the focus, from a direction", () => {
  const NOW = new Date("2026-10-27T16:00:00Z");
  const NEW_FOCUS = "```focus-update\n# Focus\n\n## Top of mind\n- Taxes only.\n\n## Quiet (silent unless the exception fires)\n- CRM until January - unless a lawsuit.\n```";
  const direct: DirectionMessage = { channel: "slack", sender: "U-PRINCIPAL", text: "Make CRM quiet until January.", receivedAt: NOW.toISOString(), messageId: "m1" };
  const run = async (root: string, message: DirectionMessage) =>
    runDirectionCore({
      store: new FsInstanceStore(root),
      message,
      provider: new FakeProvider(() => ({ text: `Done: CRM is quiet until January.\n\n${NEW_FOCUS}` })),
      now: NOW,
      timeZone: "America/New_York",
      runId: "f1000000-0000-0000-0000-000000000000",
    });
  const ledger = async (root: string) => (await readFile(path.join(root, "ledger/actions.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("a direct message rewrites the focus, keeps its header, dates it, and keeps the block out of the reply", async () => {
    const root = await makeInstance({ "bundle/ops/focus.md": FOCUS });
    const report = await run(root, direct);
    expect(report.reply.trim()).toBe("Done: CRM is quiet until January.");
    expect(report.reply).not.toContain("focus-update");
    const written = await readFile(path.join(root, "bundle/ops/focus.md"), "utf8");
    expect(written).toContain("CRM until January - unless a lawsuit.");
    expect(written).toContain("type: focus");
    expect(written).toMatch(/date: ['"]?2026-10-27/);
    expect(written).toContain("stale_after: 2026-11-26T00:00:00Z");
    expect(written).toContain("lines: 2"); // brief settings survive
    expect((await ledger(root)).map((e) => e.action)).toContain("focus-updated");
  });

  it("a teammate's group mention cannot move it; a configured focus editor can", async () => {
    const teammate: DirectionMessage = { ...direct, sender: "U-TEAMMATE", audience: "group" };
    const root = await makeInstance({ "bundle/ops/focus.md": FOCUS }, { direction: { focusEditors: ["U-PRINCIPAL"] } });
    await run(root, teammate);
    expect(await readFile(path.join(root, "bundle/ops/focus.md"), "utf8")).not.toContain("CRM until January");
    expect((await ledger(root)).find((e) => e.action === "focus-update-denied")?.detail.reason).toMatch(/only the principal/);

    await run(root, { ...teammate, sender: "U-PRINCIPAL" });
    expect(await readFile(path.join(root, "bundle/ops/focus.md"), "utf8")).toContain("CRM until January");
  });

  it("without focus-update on the whitelist the gate denies it", async () => {
    const root = await makeInstance({
      "bundle/ops/focus.md": FOCUS,
      "bundle/agents/chief-of-staff.md": concept("agent", { name: "chief-of-staff", title: "Hub", level: "L3", model: "m", harness: "fake" }, "Job."),
    });
    await run(root, direct);
    expect(await readFile(path.join(root, "bundle/ops/focus.md"), "utf8")).not.toContain("CRM until January");
    expect((await ledger(root)).find((e) => e.action === "focus-update-denied")?.detail.reason).toMatch(/not on its whitelist/);
  });

  it("parses and strips the block", () => {
    expect(parseFocusUpdate(`ok\n${NEW_FOCUS}`)).toContain("## Top of mind");
    expect(parseFocusUpdate("no block")).toBeNull();
    expect(stripFocusUpdates(`ok\n\n${NEW_FOCUS}\n`).trim()).toBe("ok");
  });
});
