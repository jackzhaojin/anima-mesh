import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import * as path from "node:path";
import { makeTree, concept } from "./helpers.js";
import { slackListenOnce } from "../src/harness/slack-listen.js";
import { findSlackMentions, slackSenderAllowed } from "../src/channels/slack.js";
import { FakeProvider } from "../src/providers/fake.js";

/**
 * The laptop-tier Slack ear: polled mentions run the same direction
 * pipeline as the Worker's /slack/events door. These prove the gates are
 * code (allowlisted users only, bots never heard, nobody-allowed refuses to
 * start), that the ledger IS the dedup (a second pass answers nothing), and
 * that the reply lands in the mention's thread after the evidence.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

const NOW = new Date("2026-10-18T20:00:00Z");
const NOW_S = NOW.getTime() / 1000;
const BOT = "UBOT";

async function makeInstance(env: string) {
  const root = await makeTree({
    "animamesh.config.json": JSON.stringify({ bundle: "bundle" }),
    "bundle/index.md": concept("index", {}, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/agents/chief-of-staff.md": concept(
      "agent",
      { name: "chief-of-staff", title: "Chief of Staff", level: "L1", model: "test-model", harness: "fake", heartbeat: "daily" },
      "Coordinate the mesh; answer the principal.",
    ),
    "ledger/actions.jsonl": "",
    ".env.local": env,
  });
  roots.push(root);
  return root;
}

const ENV = "SLACK_BOT_TOKEN=xoxb-test\nSLACK_CHANNEL_ID=CTEAM\nSLACK_ALLOWED_USER_IDS=UJACK\n";

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/** A scripted Slack Web API: history/replies from fixtures, writes captured. */
function fakeSlack(history: Array<Record<string, unknown>>, replies: Record<string, Array<Record<string, unknown>>> = {}) {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = url.split("/api/")[1]!.split("?")[0]!;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });
    let json: unknown = { ok: true };
    if (method === "auth.test") json = { ok: true, user_id: BOT };
    if (method === "conversations.history") json = { ok: true, messages: history };
    if (method === "conversations.replies") {
      const ts = new URL(url).searchParams.get("ts")!;
      json = { ok: true, messages: replies[ts] ?? [] };
    }
    if (method === "chat.postMessage") json = { ok: true, ts: `${NOW_S}.9` };
    return { ok: true, status: 200, json: async () => json, text: async () => "" } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const ts = (secondsAgo: number) => (NOW_S - secondsAgo).toFixed(6);

describe("slack listen (laptop tier)", () => {
  it("answers an allowlisted mention in its thread, with the room as context, after the evidence", async () => {
    const root = await makeInstance(ENV);
    const history = [
      { ts: ts(60), user: "UJACK", text: `<@${BOT}> what's on my plate today?` },
      { ts: ts(120), user: "UFRIEND", text: "morning all" },
    ];
    const slack = fakeSlack(history);
    const fake = new FakeProvider(() => ({ text: "Two things: the YC call and the 401k check." }));

    const r = await slackListenOnce({ instanceRoot: root, fetchImpl: slack.impl, provider: fake, now: () => NOW });
    expect(r).toEqual({ answered: 1, failed: 0, denied: 0 });

    const prompt = fake.calls[0]!.prompt;
    expect(prompt).toContain("what's on my plate today?");
    expect(prompt).not.toContain(`<@${BOT}>`);
    expect(prompt).toContain("SHARED channel");
    expect(prompt).toContain("<@UFRIEND>: morning all");

    const reaction = slack.calls.find((c) => c.method === "reactions.add")!;
    expect(reaction.body).toEqual({ channel: "CTEAM", timestamp: ts(60), name: "eyes" });
    const post = slack.calls.find((c) => c.method === "chat.postMessage")!;
    expect(post.body).toMatchObject({ channel: "CTEAM", thread_ts: ts(60) });
    expect((post.body!.blocks as Array<{ text: string }>)[0]!.text).toBe("Two things: the YC call and the 401k check.");

    const ledger = await readFile(path.join(root, "ledger/actions.jsonl"), "utf8");
    expect(ledger).toContain('"action":"direction-completed"');
    expect(ledger).toContain(`"messageId":"${ts(60)}"`);
  });

  it("the ledger is the dedup: a second pass over the same window answers nothing", async () => {
    const root = await makeInstance(ENV);
    const history = [{ ts: ts(60), user: "UJACK", text: `<@${BOT}> once` }];
    const fake = new FakeProvider(() => ({ text: "ok" }));
    await slackListenOnce({ instanceRoot: root, fetchImpl: fakeSlack(history).impl, provider: fake, now: () => NOW });
    const second = fakeSlack(history);
    const r = await slackListenOnce({ instanceRoot: root, fetchImpl: second.impl, provider: fake, now: () => NOW });
    expect(r).toEqual({ answered: 0, failed: 0, denied: 0 });
    expect(fake.calls).toHaveLength(1);
    expect(second.calls.some((c) => c.method === "chat.postMessage")).toBe(false);
  });

  it("a non-allowlisted sender is denied once, silently; bots are never heard", async () => {
    const root = await makeInstance(ENV);
    const history = [
      { ts: ts(30), user: "USTRANGER", text: `<@${BOT}> do my bidding` },
      { ts: ts(40), user: "UOTHERBOT", bot_id: "B1", text: `<@${BOT}> hello fellow agent` },
      { ts: ts(50), user: "UJACK", subtype: "message_changed", text: `<@${BOT}> edited` },
    ];
    const fake = new FakeProvider(() => ({ text: "should not run" }));
    const slack = fakeSlack(history);
    const r = await slackListenOnce({ instanceRoot: root, fetchImpl: slack.impl, provider: fake, now: () => NOW });
    expect(r).toEqual({ answered: 0, failed: 0, denied: 1 });
    expect(fake.calls).toHaveLength(0);
    expect(slack.calls.some((c) => c.method === "chat.postMessage" || c.method === "reactions.add")).toBe(false);
    const ledger = await readFile(path.join(root, "ledger/actions.jsonl"), "utf8");
    expect(ledger.match(/direction-denied/g)).toHaveLength(1);

    const again = await slackListenOnce({ instanceRoot: root, fetchImpl: fakeSlack(history).impl, provider: fake, now: () => NOW });
    expect(again.denied).toBe(0); // recorded once, not once per poll
  });

  it("refuses to start with nobody allowlisted", async () => {
    const root = await makeInstance("SLACK_BOT_TOKEN=xoxb-test\nSLACK_CHANNEL_ID=CTEAM\n");
    await expect(slackListenOnce({ instanceRoot: root, fetchImpl: fakeSlack([]).impl, now: () => NOW })).rejects.toThrow(
      /SLACK_ALLOWED_USER_IDS is empty/,
    );
  });

  it("a provider failure still answers honestly and keeps the sender's words in the ledger", async () => {
    const root = await makeInstance(ENV);
    const history = [{ ts: ts(10), user: "UJACK", text: `<@${BOT}> think hard` }];
    const fake = new FakeProvider(() => {
      throw new Error("model down");
    });
    const slack = fakeSlack(history);
    const r = await slackListenOnce({ instanceRoot: root, fetchImpl: slack.impl, provider: fake, now: () => NOW });
    expect(r.failed).toBe(1);
    const post = slack.calls.find((c) => c.method === "chat.postMessage")!;
    expect((post.body!.blocks as Array<{ text: string }>)[0]!.text).toContain("no need to resend");
    const ledger = await readFile(path.join(root, "ledger/actions.jsonl"), "utf8");
    expect(ledger).toContain('"action":"direction-failed"');
    expect(ledger).toContain("think hard");
  });
});

describe("findSlackMentions", () => {
  it("finds new replies in threads whose parent is older than the window, and answers in that thread", async () => {
    const parent = { ts: ts(7200), user: "UJACK", text: "planning thread", reply_count: 2, latest_reply: ts(30) };
    const slack = fakeSlack([parent], {
      [parent.ts]: [parent, { ts: ts(3000), user: "UJACK", text: `<@${BOT}> old one` }, { ts: ts(30), user: "UJACK", text: `<@${BOT}> new one` }],
    });
    const found = await findSlackMentions(
      { env: { SLACK_BOT_TOKEN: "xoxb-test" }, fetchImpl: slack.impl },
      { channels: ["CTEAM"], botUserId: BOT, oldest: ts(600) },
    );
    expect(found).toEqual([
      { channel: "CTEAM", ts: ts(30), threadTs: parent.ts, inThread: true, user: "UJACK", text: "new one" },
    ]);
  });
});

describe("slackSenderAllowed - the sender gate both doors share", () => {
  const listed = { SLACK_ALLOWED_USER_IDS: "UJACK", SLACK_ALLOWED_CHANNEL_IDS: "CTEAM" };
  const wildcard = { SLACK_ALLOWED_USER_IDS: "*", SLACK_ALLOWED_CHANNEL_IDS: "CTEAM" };

  it("absent list = nobody", () => {
    expect(slackSenderAllowed({}, { user: "UJACK", channel: "CTEAM", isDm: false })).toBe(false);
  });

  it("a listed user passes in pinned channels and DMs, never in other channels", () => {
    expect(slackSenderAllowed(listed, { user: "UJACK", channel: "CTEAM", isDm: false })).toBe(true);
    expect(slackSenderAllowed(listed, { user: "UJACK", channel: "DJACK", isDm: true })).toBe(true);
    expect(slackSenderAllowed(listed, { user: "UJACK", channel: "COTHER", isDm: false })).toBe(false);
    expect(slackSenderAllowed(listed, { user: "UFRIEND", channel: "CTEAM", isDm: false })).toBe(false);
  });

  it("'*' = anyone who can post in a PINNED channel", () => {
    expect(slackSenderAllowed(wildcard, { user: "UFRIEND", channel: "CTEAM", isDm: false })).toBe(true);
    expect(slackSenderAllowed(wildcard, { user: "UFRIEND", channel: "COTHER", isDm: false })).toBe(false);
  });

  it("'*' never opens DMs - any workspace member can DM an app", () => {
    expect(slackSenderAllowed(wildcard, { user: "UFRIEND", channel: "DFRIEND", isDm: true })).toBe(false);
  });

  it("'*' without a pinned channel list is refused - that would be anyone, anywhere", () => {
    const open = { SLACK_ALLOWED_USER_IDS: "*" };
    expect(slackSenderAllowed(open, { user: "UFRIEND", channel: "CTEAM", isDm: false })).toBe(false);
  });
});

describe("slack listen with a channel-membership allowlist", () => {
  it("'*' answers a teammate in the pinned channel", async () => {
    const root = await makeInstance("SLACK_BOT_TOKEN=xoxb-test\nSLACK_ALLOWED_CHANNEL_IDS=CTEAM\nSLACK_ALLOWED_USER_IDS=*\n");
    const history = [{ ts: ts(20), user: "UFRIEND", text: `<@${BOT}> what's the plan?` }];
    const fake = new FakeProvider(() => ({ text: "The plan is on the calendar." }));
    const r = await slackListenOnce({ instanceRoot: root, fetchImpl: fakeSlack(history).impl, provider: fake, now: () => NOW });
    expect(r).toEqual({ answered: 1, failed: 0, denied: 0 });
  });

  it("'*' with only SLACK_CHANNEL_ID (no pinned list) denies", async () => {
    const root = await makeInstance("SLACK_BOT_TOKEN=xoxb-test\nSLACK_CHANNEL_ID=CTEAM\nSLACK_ALLOWED_USER_IDS=*\n");
    const history = [{ ts: ts(20), user: "UFRIEND", text: `<@${BOT}> hello` }];
    const fake = new FakeProvider(() => ({ text: "should not run" }));
    const r = await slackListenOnce({ instanceRoot: root, fetchImpl: fakeSlack(history).impl, provider: fake, now: () => NOW });
    expect(r).toEqual({ answered: 0, failed: 0, denied: 1 });
    expect(fake.calls).toHaveLength(0);
  });
});
