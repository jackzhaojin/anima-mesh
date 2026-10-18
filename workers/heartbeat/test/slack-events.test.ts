import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SELF, env, fetchMock, runInDurableObject } from "cloudflare:test";
import {
  mockGitHub,
  mockKimi,
  mockSlack,
  signedSlackEvent,
  slackEnvelope,
  slackMention,
  SLACK_BOT_USER,
  wipeHeartbeatDo,
  type SlackScript,
} from "./fixtures.js";
import { verifySlackSignature } from "../src/slack-events.js";

/**
 * The Slack edge in real workerd: HMAC + replay window at the door, the
 * url_verification handshake, the bot/edit filter, the sender and channel
 * gates, event-id dedup against Slack's retries, and the full flow -
 * enqueue → 👀 → the DirectionDO thinks on fake Kimi with the channel's
 * conversation as context → ONE commit → the reply lands in the mention's
 * thread as a markdown block.
 */

beforeEach(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  await wipeHeartbeatDo();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors(); // the mock plan IS the expected traffic
  fetchMock.deactivate();
});

const directionStub = () => env.DIRECTION_DO.get(env.DIRECTION_DO.idFromName("main"));

async function send(payload: unknown, opts?: Parameters<typeof signedSlackEvent>[1]): Promise<Response> {
  const req = await signedSlackEvent(payload, opts);
  return SELF.fetch(req.url, {
    method: "POST",
    headers: Object.fromEntries(req.headers.entries()),
    body: await req.text(),
  });
}

async function waitForPosts(script: SlackScript, n = 1): Promise<void> {
  await vi.waitFor(
    () => {
      if (script.posts.length < n) throw new Error(`slack posts: ${script.posts.length}/${n}`);
    },
    { timeout: 5_000, interval: 20 },
  );
}

async function deniedRecords(): Promise<Array<{ channel: string; sender: string }>> {
  return (
    (await runInDurableObject(directionStub(), (_i, state) =>
      state.storage.get<Array<{ channel: string; sender: string }>>("denied"),
    )) ?? []
  );
}

async function queued(): Promise<unknown[]> {
  return (await runInDurableObject(directionStub(), (_i, state) => state.storage.get<unknown[]>("queue"))) ?? [];
}

describe("the door: signature, replay window, handshake", () => {
  it("echoes the url_verification challenge when correctly signed", async () => {
    const res = await send({ type: "url_verification", challenge: "chal-123" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "chal-123" });
  });

  it("rejects a bad signature with 401", async () => {
    const res = await SELF.fetch("https://worker.test/slack/events", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": `v0=${"ab".repeat(32)}`,
      },
      body: JSON.stringify({ type: "url_verification", challenge: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a correctly signed but stale request (replay) with 401", async () => {
    const res = await send(
      { type: "url_verification", challenge: "x" },
      { timestamp: Math.floor(Date.now() / 1000) - 600 },
    );
    expect(res.status).toBe(401);
  });

  it("verifySlackSignature matches Slack's documented test vector", async () => {
    // From Slack's "Verifying requests from Slack" guide.
    const ok = await verifySlackSignature(
      "8f742231b10e8888abcd99yyyzzz85a5",
      "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
      "1531420618",
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c",
      1531420618,
    );
    expect(ok).toBe(true);
  });
});

describe("the gates", () => {
  it("a stranger's mention gets no reply; the attempt is recorded", async () => {
    const res = await send(slackEnvelope(slackMention("do my bidding", { user: "USTRANGER" })));
    expect(res.status).toBe(200);
    expect(await deniedRecords()).toEqual([expect.objectContaining({ channel: "slack", sender: "USTRANGER" })]);
    expect(await queued()).toHaveLength(0);
  });

  it("an allowed user in a channel outside SLACK_ALLOWED_CHANNEL_IDS is denied too", async () => {
    await send(slackEnvelope(slackMention("status?", { channel: "COTHER" })));
    expect(await deniedRecords()).toEqual([expect.objectContaining({ sender: "UPRINCIPAL in COTHER" })]);
    expect(await queued()).toHaveLength(0);
  });

  it("bot-authored messages and edits are dropped silently - no loops, no denial noise", async () => {
    await send(slackEnvelope({ ...slackMention("ping"), bot_id: "BOTHER", user: "UOTHERBOT" }, "Ev-bot"));
    await send(slackEnvelope({ ...slackMention("ping"), subtype: "message_changed" }, "Ev-edit"));
    await send(slackEnvelope({ ...slackMention("ping"), user: SLACK_BOT_USER }, "Ev-self"));
    expect(await deniedRecords()).toHaveLength(0);
    expect(await queued()).toHaveLength(0);
  });

  it("plain channel messages (not mentions, not DMs) are ignored", async () => {
    await send(slackEnvelope({ type: "message", channel_type: "channel", user: "UPRINCIPAL", text: "hi", ts: "1.1", channel: "CTEAM" }));
    expect(await deniedRecords()).toHaveLength(0);
    expect(await queued()).toHaveLength(0);
  });
});

describe("the full flow", () => {
  it("mention → 👀 → thinks with channel context → ONE commit → reply in the mention's thread", async () => {
    const gh = mockGitHub();
    const kimi = mockKimi("**On track** - annual return due 2026-09-15. <@UTEAMMATE> nothing needed from you.");
    const slack = mockSlack({
      context: "history",
      contextMessages: [
        { ts: "1759999999.000300", user: "UTEAMMATE", text: "is the annual return on our radar?" },
        { ts: "1759999998.000200", user: SLACK_BOT_USER, text: "morning brief posted" },
      ],
    });

    const res = await send(slackEnvelope(slackMention("what's the status of the annual return?", { user: "UTEAMMATE" })));
    expect(res.status).toBe(200);
    await waitForPosts(slack);

    // Seen-and-thinking acknowledgment on the triggering message.
    await vi.waitFor(() => expect(slack.reactions).toHaveLength(1));
    expect(slack.reactions[0]).toEqual({ channel: "CTEAM", timestamp: "1760000000.000100", name: "eyes" });

    // Context came from the channel's recent history, before the mention.
    expect(slack.historyPaths[0]).toContain("channel=CTEAM");
    expect(slack.historyPaths[0]).toContain("latest=1760000000.000100");

    // Cognition saw the cleaned direction, the group framing, and the room.
    const prompt = kimi.requests[0]!.messages.find((m) => m.role === "user")!.content;
    expect(prompt).toContain("what's the status of the annual return?");
    expect(prompt).not.toContain(`<@${SLACK_BOT_USER}>`);
    expect(prompt).toContain("SHARED channel");
    expect(prompt).toContain("Conversation so far");
    expect(prompt).toMatch(/you: morning brief posted\n<@UTEAMMATE>: is the annual return on our radar\?/);

    // ONE commit of evidence; the artifact records the group audience.
    expect(gh.trees).toHaveLength(1);
    const artifact = gh.trees[0]!.tree.find((t) => t.path.includes(".direction-"))!;
    expect(artifact.content).toContain("channel: slack");
    expect(artifact.content).toContain("audience: group");
    expect(artifact.content).not.toContain("is the annual return on our radar"); // other people's words stay out of the repo

    // The reply: in the mention's own thread, as a markdown block.
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]!.channel).toBe("CTEAM");
    expect(slack.posts[0]!.thread_ts).toBe("1760000000.000100");
    expect(slack.posts[0]!.blocks).toEqual([
      { type: "markdown", text: "**On track** - annual return due 2026-09-15. <@UTEAMMATE> nothing needed from you." },
    ]);
  });

  it("Slack's retry of the same event_id is acknowledged but never runs twice", async () => {
    mockGitHub();
    mockKimi("done");
    const slack = mockSlack();
    const payload = slackEnvelope(slackMention("once only"), "Ev-retry");
    await send(payload);
    const retry = await send(payload, { headers: { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" } });
    expect(retry.status).toBe(200);
    await waitForPosts(slack);
    expect(slack.posts).toHaveLength(1);
    expect(slack.reactions).toHaveLength(1);
  });

  it("a mention inside a thread reads that thread and answers in it", async () => {
    mockGitHub();
    const kimi = mockKimi("Agreed.");
    const slack = mockSlack({
      context: "replies",
      contextMessages: [
        { ts: "1759990000.000001", user: "UPRINCIPAL", text: "kickoff: plan the offsite" },
        { ts: "1760000000.000100", user: "UPRINCIPAL", text: `<@${SLACK_BOT_USER}> thoughts?` },
      ],
    });
    await send(slackEnvelope(slackMention("thoughts?", { threadTs: "1759990000.000001" })));
    await waitForPosts(slack);

    expect(slack.historyPaths[0]).toContain("ts=1759990000.000001");
    const prompt = kimi.requests[0]!.messages.find((m) => m.role === "user")!.content;
    expect(prompt).toContain("<@UPRINCIPAL>: kickoff: plan the offsite");
    expect(prompt).not.toMatch(/<@UPRINCIPAL>: .*thoughts\?/); // the trigger itself is not repeated as context
    expect(slack.posts[0]!.thread_ts).toBe("1759990000.000001");
  });

  it("a DM from an allowed user is a direct audience and answers in-line", async () => {
    mockGitHub();
    const kimi = mockKimi("Private answer.");
    const slack = mockSlack({ context: "history" });
    await send(
      slackEnvelope(
        { type: "message", channel_type: "im", user: "UPRINCIPAL", text: "how are my finances?", ts: "1760000100.000001", channel: "DPRIVATE" },
        "Ev-dm",
      ),
    );
    await waitForPosts(slack);

    const prompt = kimi.requests[0]!.messages.find((m) => m.role === "user")!.content;
    expect(prompt).toContain("your principal — already authenticated");
    expect(prompt).not.toContain("SHARED channel");
    expect(slack.posts[0]!.channel).toBe("DPRIVATE");
    expect(slack.posts[0]!.thread_ts).toBeUndefined();
  });

  it("missing history scope degrades to no context, never a failed direction", async () => {
    mockGitHub();
    mockKimi("Still answered.");
    const slack = mockSlack({ context: null });
    fetchMock
      .get("https://slack.com")
      .intercept({ method: "GET", path: (p: string) => p.startsWith("/api/conversations.history?") })
      .reply(200, { ok: false, error: "missing_scope" });
    await send(slackEnvelope(slackMention("still there?"), "Ev-noscope"));
    await waitForPosts(slack);
    expect(slack.posts[0]!.blocks[0]!.text).toBe("Still answered.");
  });
});

describe("the budget gate (test cap = 3)", () => {
  it("over the daily cap: an ephemeral notice to the sender, no cognition", async () => {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: env.BEAT_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    await runInDurableObject(directionStub(), (_i, state) => state.storage.put(`count:${today}`, 3));
    const slack = mockSlack({ posts: 0, reactions: 0, ephemerals: 1, context: null });
    const res = await send(slackEnvelope(slackMention("one too many"), "Ev-budget"));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(slack.ephemerals).toHaveLength(1));
    expect(slack.ephemerals[0]).toMatchObject({ channel: "CTEAM", user: "UPRINCIPAL" });
    expect(slack.ephemerals[0]!.text).toContain("budget reached");
    expect(await queued()).toHaveLength(0);
  });
});
