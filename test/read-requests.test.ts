import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import * as path from "node:path";
import { makeTree, concept } from "./helpers.js";
import { runAgent } from "../src/harness/run.js";
import { runDirectionCore, type DirectionMessage } from "../src/harness/direction-core.js";
import { FsInstanceStore } from "../src/instance/store-fs.js";
import { FakeProvider } from "../src/providers/fake.js";
import { parseReadRequests, stripReadRequests, MAX_DRIVE_READ_ROUNDS, TOTAL_READ_CHARS } from "../src/harness/read-requests.js";
import { createAnthropicApiProvider } from "../src/providers/anthropic-api.js";

/**
 * Ask-driven retrieval (v0.17.0). The inline heuristics can't know what THIS
 * run is about — "read my 2015 agreement" loses every recency race. The model
 * ends its output with a `read-request` block; deterministic code validates,
 * serves, ledgers, and runs the agent ONCE more.
 *
 * What must hold: the loop is exactly one round; every refusal (undeclared
 * source, jailed path, cap overflow, missing file) is a visible line in the
 * served section; the final artifact carries no request blocks; the ledger
 * records the retrieval.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function makeInstance(extraFiles: Record<string, string> = {}) {
  const root = await makeTree({
    "animamesh.config.json": JSON.stringify({ bundle: "bundle" }, null, 2),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/agents/hub.md": concept(
      "agent",
      { name: "hub", title: "Hub", level: "L1", model: "test-model", harness: "fake" },
      "Coordinate the mesh.",
    ),
    "bundle/cabinet/legal.md": concept("document-set", {}, "# Legal file\n\nThe clause text: ALPHA-42.\n"),
    ...extraFiles,
  });
  roots.push(root);
  return root;
}

/** A provider that asks for reads on call 1 and reports on call 2. */
function askingProvider(block: string, finalText = "Final report: grounded in ALPHA-42.") {
  let call = 0;
  return new FakeProvider(() => {
    call++;
    return call === 1 ? { text: `I need a file first.\n\n${block}\n` } : { text: finalText };
  });
}

const REQUEST_BLOCK = "```read-request\nbundle: [cabinet/legal.md]\n```";

describe("Google Drive search followed by visual inspection (issue #18)", () => {
  const googleEnv = { GOOGLE_READ_CLIENT_ID: "cid", GOOGLE_READ_CLIENT_SECRET: "secret", GOOGLE_READ_REFRESH_TOKEN: "refresh" };
  const imageData = "iVBORw0KGgo=";
  const block = (yaml: string) => `\`\`\`read-request\n${yaml}\n\`\`\``;
  const driveAgent = () => concept("agent", {
    name: "hub", title: "Hub", level: "L1", model: "test-model", harness: "fake", heartbeat: "daily", "context-sources": ["google-drive"],
  }, "Find the requested file, then inspect its image.");

  it.each(["beat", "direction"])("%s follows actual search and folder results before sending pixels, with no bytes in stored evidence", async (entrypoint) => {
    const root = await makeInstance({ "bundle/agents/hub.md": driveAgent() });
    const calls: { url: string; method: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url: url.href, method: init?.method ?? "GET" });
      if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "access-test" });
      if (url.pathname.endsWith("/files")) {
        const q = url.searchParams.get("q")!;
        if (q.includes("modifiedTime >")) return Response.json({ files: [] });
        if (q.includes("name contains 'Archive'")) return Response.json({ files: [{ id: "FolderArchive001", name: "Archive", mimeType: "application/vnd.google-apps.folder" }] });
        expect(q).toContain("'FolderArchive001' in parents");
        return Response.json({ files: [{ id: "OldPortrait00001", name: "headshot.png", mimeType: "image/png", modifiedTime: "2000-01-01T00:00:00Z" }] });
      }
      expect(url.pathname).toContain("OldPortrait00001");
      return url.searchParams.get("alt") === "media"
        ? new Response(Buffer.from(imageData, "base64"))
        : Response.json({ id: "OldPortrait00001", name: "headshot.png", mimeType: "image/png", size: "8" });
    };
    const outputs = [
      block("google-drive-search: [{name: Archive, mimeType: application/vnd.google-apps.folder}]"),
      block("google-drive-search: [{folder: FolderArchive001, name: headshot, mimeType: 'image/'}]"),
      block("google-drive-image: [OldPortrait00001]"),
      "The image has a warm background. Printed account 000123456789; SSN 123-45-6789.",
    ];
    let index = 0;
    const provider = new FakeProvider(() => ({ text: outputs[index++]! }), { fileReads: false, webSearch: false, vision: true });
    const providerCtx = { env: googleEnv, fetchImpl };
    const report = entrypoint === "beat"
      ? await runAgent({ instanceRoot: root, agentName: "hub", provider, providerCtx, timeZone: "UTC" })
      : await runDirectionCore({ store: new FsInstanceStore(root), agentName: "hub", provider, providerCtx, timeZone: "UTC",
          message: { channel: "test", sender: "operator", text: "Find the old portrait and describe the background.", receivedAt: new Date().toISOString() } });
    expect(report.ok).toBe(true);
    expect(provider.calls).toHaveLength(4);
    expect(provider.calls[1]!.prompt).toContain("FolderArchive001");
    expect(provider.calls[2]!.prompt).toContain("2000-01-01");
    expect(provider.calls[2]!.images).toBeUndefined();
    expect(provider.calls[3]!.images).toEqual([{ mediaType: "image/png", data: imageData, label: "google-drive: OldPortrait00001 (headshot.png)" }]);
    const artifact = await readFile(report.reportPath, "utf8");
    const ledger = await readFile(path.join(root, "ledger/actions.jsonl"), "utf8");
    expect(artifact).toContain("warm background");
    for (const text of [artifact, ledger]) {
      expect(text).not.toContain(imageData);
      expect(text).not.toContain("access-test");
      expect(text).not.toContain("000123456789");
      expect(text).not.toContain("123-45-6789");
    }
    const reads = ledger.trim().split("\n").map((line) => JSON.parse(line)).filter((e) => e.action === "reads-requested");
    expect(reads).toHaveLength(3);
    expect(reads[2].detail).toMatchObject({ images: 1, imageBytes: 8, round: 3 });
    expect(calls.filter((c) => c.url.includes("/drive/")).every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses virtual Drive sources without the underlying source grant", async () => {
    const root = await makeInstance();
    let networkCalls = 0;
    const provider = askingProvider(block("google-drive-search: [{name: portrait}]\ngoogle-drive-image: [OldPortrait00001]"));
    await runAgent({ instanceRoot: root, agentName: "hub", provider,
      providerCtx: { env: googleEnv, fetchImpl: async () => { networkCalls++; return Response.json({}); } } });
    expect(networkCalls).toBe(0);
    expect(provider.calls[1]!.prompt).toContain("source 'google-drive-search' is not available");
    expect(provider.calls[1]!.prompt).toContain("source 'google-drive-image' is not available");
  });

  it("refuses pixel reads before any image fetch when the provider lacks vision", async () => {
    const root = await makeInstance({ "bundle/agents/hub.md": driveAgent() });
    let mediaCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "test" });
      if (!url.includes("/files?q=")) mediaCalls++;
      return Response.json({ files: [] });
    };
    const provider = askingProvider(block("google-drive-image: [OldPortrait00001]"));
    await runAgent({ instanceRoot: root, agentName: "hub", provider, providerCtx: { env: googleEnv, fetchImpl } });
    expect(mediaCalls).toBe(0);
    expect(provider.calls[1]!.prompt).toContain("pixels were not fetched or inspected");
    expect(provider.calls[1]!.images).toBeUndefined();
  });

  it("caps persistent requests and shares the text budget across all rounds", async () => {
    const root = await makeInstance({ "bundle/agents/hub.md": driveAgent(), "bundle/ops/long.md": concept("fact", {}, "x".repeat(20_000)) });
    const provider = new FakeProvider(() => ({ text: block("bundle: [ops/long.md]") }));
    const report = await runAgent({ instanceRoot: root, agentName: "hub", provider, providerCtx: { env: {} } });
    expect(provider.calls).toHaveLength(MAX_DRIVE_READ_ROUNDS + 1);
    const store = new FsInstanceStore(root);
    const reads = (await store.readLedger()).filter((e) => e.action === "reads-requested");
    expect(reads.reduce((sum, e) => sum + Number((e.detail as { chars?: number })?.chars ?? 0), 0)).toBeLessThanOrEqual(TOTAL_READ_CHARS);
    expect(await readFile(report.reportPath, "utf8")).toContain("bounded read-request budget is exhausted");
  });

  it("shares the eight-request cap across rounds instead of resetting it per continuation", async () => {
    const root = await makeInstance({ "bundle/agents/hub.md": driveAgent() });
    const provider = new FakeProvider(() => ({ text: block("bundle: [cabinet/legal.md, cabinet/legal.md, cabinet/legal.md, cabinet/legal.md]") }));
    await runAgent({ instanceRoot: root, agentName: "hub", provider, providerCtx: { env: {} } });
    expect(provider.calls).toHaveLength(3);
    const reads = (await new FsInstanceStore(root).readLedger()).filter((e) => e.action === "reads-requested");
    expect(reads).toHaveLength(2);
    expect(reads.reduce((sum, e) => sum + Number((e.detail as { served?: number }).served ?? 0), 0)).toBe(8);
  });

  it("shares the two-image cap across continuations, refusing a third image before fetching it", async () => {
    const root = await makeInstance({ "bundle/agents/hub.md": driveAgent() });
    const ids = ["ImageCandidate1", "ImageCandidate2", "ImageCandidate3"];
    const fetched: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "test" });
      if (url.pathname.endsWith("/files")) return Response.json({ files: [] });
      fetched.push(url.pathname);
      return url.searchParams.get("alt") === "media" ? new Response(Buffer.from(imageData, "base64"))
        : Response.json({ mimeType: "image/png", size: "8" });
    };
    let turn = 0;
    const provider = new FakeProvider(() => ({ text: turn < 3 ? block(`google-drive-image: [${ids[turn++]}]`) : "Inspected two images; third unavailable." }),
      { fileReads: false, webSearch: false, vision: true });
    const report = await runAgent({ instanceRoot: root, agentName: "hub", provider, providerCtx: { env: googleEnv, fetchImpl } });
    expect(report.ok).toBe(true);
    expect(fetched.some((url) => url.includes(ids[2]!))).toBe(false);
    expect(provider.calls[3]!.images).toHaveLength(2);
    expect(provider.calls[3]!.prompt).toContain("2-image run budget is spent");
  });
});

describe("parse + strip", () => {
  it("parses multi-source blocks into source/path pairs", () => {
    const text = 'x\n```read-request\nonedrive: [Legal/a.pdf, "Finance/b.csv"]\nbundle: [cabinet/c.md]\n```\ny';
    expect(parseReadRequests(text)).toEqual([
      { source: "onedrive", path: "Legal/a.pdf" },
      { source: "onedrive", path: "Finance/b.csv" },
      { source: "bundle", path: "cabinet/c.md" },
    ]);
  });

  it("marks an unparseable block instead of dropping it", () => {
    const requests = parseReadRequests("```read-request\n: [broken\n```");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.source).toBe("(malformed)");
  });

  it("strips request blocks and collapses the gap", () => {
    const stripped = stripReadRequests(`before\n\n${REQUEST_BLOCK}\n\nafter`);
    expect(stripped).not.toContain("read-request");
    expect(stripped).toBe("before\n\nafter");
  });
});

describe("the retrieval loop — beat runs", () => {
  it("does not write a successful report or apply requests from an unfinished long job", async () => {
    const root = await makeInstance();
    const provider = createAnthropicApiProvider({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-not-real" },
      fetchImpl: async () => Response.json({ content: [{ type: "text", text: "Incomplete report\n```draft-request\npath: unfinished.md\n---\npartial\n```" }], stop_reason: "max_tokens" }),
    });
    await expect(runAgent({ instanceRoot: root, agentName: "hub", provider })).rejects.toThrow("output still incomplete");
    const store = new FsInstanceStore(root);
    expect(await store.listReports()).toEqual([]);
    expect(await store.readOptional("drafts/unfinished.md")).toBeNull();
    expect((await store.readLedger()).some((entry) => entry.action === "run-completed")).toBe(false);
  });

  it("retrieves the full report beyond the ambient preview and ordinary per-file read cap", async () => {
    const full = "# Long report\n" + "context ".repeat(2500) + "\nCRITICAL-TAIL-EVIDENCE";
    const name = "2026-08-03-spoke-long.md";
    const root = await makeInstance({ [`reports/${name}`]: full });
    const provider = askingProvider(`\`\`\`read-request\nreports: [${name}]\n\`\`\``);
    await runAgent({ instanceRoot: root, agentName: "hub", provider });
    expect(provider.calls[0]!.prompt).toContain("preview truncated");
    expect(provider.calls[0]!.prompt).not.toContain("CRITICAL-TAIL-EVIDENCE");
    expect(provider.calls[1]!.prompt).toContain(full);
    expect(provider.calls).toHaveLength(2);
  });

  it("report requests cannot escape the jail or read arbitrary instance files", async () => {
    const root = await makeInstance({ "local-only/private.md": "PRIVATE-CONTENT" });
    const provider = askingProvider("```read-request\nreports: [../local-only/private.md, local-only/private.md, missing.md]\n```");
    await runAgent({ instanceRoot: root, agentName: "hub", provider });
    const served = provider.calls[1]!.prompt;
    expect(served).not.toContain("PRIVATE-CONTENT");
    expect(served).toContain("path escapes the jail");
    expect(served).toContain("not found in the report listing");
  });

  it("serves a requested bundle file and runs exactly one continuation", async () => {
    const root = await makeInstance();
    const provider = askingProvider(REQUEST_BLOCK);
    const report = await runAgent({ instanceRoot: root, agentName: "hub", provider, runId: "run-reads-1" });

    expect(provider.calls).toHaveLength(2);
    // Call 1 was told about the capability; call 2 got the served file.
    expect(provider.calls[0]!.prompt).toContain("On-demand reads (one round)");
    expect(provider.calls[0]!.prompt).toContain("omitted role reads remain requestable");
    expect(provider.calls[0]!.prompt).toContain("Configured engine pin:");
    expect(provider.calls[1]!.prompt).toContain("## Requested reads (served at your request)");
    expect(provider.calls[1]!.prompt).toContain("ALPHA-42");
    expect(provider.calls[1]!.prompt).toContain("produce your complete final output now");

    // The artifact is the continuation's report, block-free.
    const artifact = await readFile(report.reportPath, "utf8");
    expect(artifact).toContain("Final report: grounded in ALPHA-42.");
    expect(artifact).not.toContain("read-request");

    // The retrieval is ledgered.
    const lines = (await readFile(path.join(root, "ledger/actions.jsonl"), "utf8")).trim().split("\n");
    const entry = lines.map((l) => JSON.parse(l)).find((e) => e.action === "reads-requested");
    expect(entry?.detail).toMatchObject({ requested: 1, served: 1, refused: 0 });
    expect(report.ok).toBe(true);
  });

  it("refuses out loud: undeclared source, jailed paths, missing files; extras dropped by name", async () => {
    const root = await makeInstance();
    const block = [
      "```read-request",
      "onedrive: [Finance/x.csv]",
      "bundle: [../secrets.md, /etc/passwd, cabinet/missing.md, cabinet/fifth.md]",
      "```",
    ].join("\n");
    const provider = askingProvider(block, "Final report: nothing served.");
    await runAgent({ instanceRoot: root, agentName: "hub", provider, runId: "run-reads-2" });

    expect(provider.calls).toHaveLength(2);
    const served = provider.calls[1]!.prompt;
    expect(served).toContain("source 'onedrive' is not available to this agent");
    expect(served).toContain("path escapes the jail");
    expect(served).toContain("not found in the bundle");
    // 5 requests, cap 4: the fifth is dropped BY NAME, never silently.
    expect(served).toContain("1 more request(s) dropped");
    expect(served).toContain("cabinet/fifth.md");

    const lines = (await readFile(path.join(root, "ledger/actions.jsonl"), "utf8")).trim().split("\n");
    const entry = lines.map((l) => JSON.parse(l)).find((e) => e.action === "reads-requested");
    expect(entry?.detail).toMatchObject({ requested: 5, served: 0, refused: 4 });
  });

  it("one round only: a request in the continuation is stripped, never served", async () => {
    const root = await makeInstance();
    // Greedy agent: asks for a read on EVERY call.
    const provider = new FakeProvider(() => ({ text: `Still curious.\n\n${REQUEST_BLOCK}\n` }));
    const report = await runAgent({ instanceRoot: root, agentName: "hub", provider, runId: "run-reads-3" });

    expect(provider.calls).toHaveLength(2); // never a third call
    const artifact = await readFile(report.reportPath, "utf8");
    expect(artifact).not.toContain("read-request");
    expect(artifact).toContain("Still curious.");
  });

  it("no request, no continuation — the loop costs nothing when unused", async () => {
    const root = await makeInstance();
    const provider = new FakeProvider(() => ({ text: "Plain report." }));
    await runAgent({ instanceRoot: root, agentName: "hub", provider, runId: "run-reads-4" });
    expect(provider.calls).toHaveLength(1);
  });
});

describe("the retrieval loop — direction runs", () => {
  const MESSAGE: DirectionMessage = {
    channel: "discord",
    sender: "principal-1",
    text: "what does our legal file actually say?",
    receivedAt: "2026-08-03T16:00:00.000Z",
    messageId: "m-1",
  };

  it("serves reads mid-direction and replies from the continuation, block-free", async () => {
    const root = await makeInstance({
      "bundle/agents/hub.md": concept(
        "agent",
        { name: "hub", title: "Hub", level: "L1", model: "test-model", harness: "fake", heartbeat: "daily" },
        "Coordinate the mesh; answer the principal.",
      ),
    });
    const provider = askingProvider(REQUEST_BLOCK, "It says ALPHA-42 — read this run at your ask.");
    const report = await runDirectionCore({
      store: new FsInstanceStore(root),
      message: MESSAGE,
      agentName: "hub",
      provider,
      now: new Date("2026-08-03T16:00:00Z"),
    });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.prompt).toContain("ALPHA-42");
    expect(report.reply).toBe("It says ALPHA-42 — read this run at your ask.");
    expect(report.reply).not.toContain("read-request");
    expect(report.ok).toBe(true);
  });
});
