import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { mockGitHub, mockKimi, wipeHeartbeatDo } from "./fixtures.js";

/**
 * Inbound email in real workerd (Q3b/Q6): the DirectionDO poll cycle —
 * unread mail from the allowlisted sender → agentic run → ONE commit of
 * evidence → reply email → mark read. POST /poll is the deterministic
 * test seam (and the manual poke); production runs the same cycle on the
 * alarm cadence.
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

const stub = () => env.DIRECTION_DO.get(env.DIRECTION_DO.idFromName("main"));

const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Script one Gmail poll cycle: token refreshes + list + get (+ send/modify when replying). */
function mockGmail(opts: { tokens: number; withReply: boolean; unreadIds?: string[] }) {
  const captured = { sentRaw: [] as string[], modified: [] as string[] };
  fetchMock
    .get("https://oauth2.googleapis.com")
    .intercept({ method: "POST", path: "/token" })
    .reply(200, { access_token: "at-1" })
    .times(opts.tokens);

  const gmail = fetchMock.get("https://gmail.googleapis.com");
  gmail
    // NB: the mock agent sorts query params before matching — match on the
    // bare list path + "?" and leave the query to the node-side unit tests.
    .intercept({ method: "GET", path: (p) => p.startsWith("/gmail/v1/users/me/messages?") })
    .reply(200, { messages: (opts.unreadIds ?? ["m1"]).map((id) => ({ id })) });
  for (const id of opts.unreadIds ?? ["m1"]) {
    gmail.intercept({ method: "GET", path: `/gmail/v1/users/me/messages/${id}?format=full` }).reply(200, {
      id,
      internalDate: "1783300000000",
      payload: {
        headers: [
          { name: "From", value: "The Principal <principal@example.test>" },
          { name: "Subject", value: "Runway question" },
        ],
        mimeType: "multipart/alternative",
        parts: [{ mimeType: "text/plain", body: { data: b64url("How many months of runway remain?") } }],
      },
    });
  }
  if (opts.withReply) {
    gmail.intercept({ method: "POST", path: "/gmail/v1/users/me/messages/send" }).reply(200, (req) => {
      captured.sentRaw.push((JSON.parse(req.body as string) as { raw: string }).raw);
      return { id: "sent-1" };
    });
    gmail.intercept({ method: "POST", path: "/gmail/v1/users/me/messages/m1/modify" }).reply(200, (req) => {
      captured.modified.push(req.path);
      return { id: "m1" };
    });
  }
  return captured;
}

function decodeB64Url(data: string): string {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

describe("the Gmail poll cycle", () => {
  it("unread principal mail → agentic run → ONE commit → reply email → mark read", async () => {
    const gh = mockGitHub();
    const kimi = mockKimi("About 14 months at current burn — details in tomorrow's brief.");
    const gmail = mockGmail({ tokens: 3, withReply: true }); // poll + send + modify

    const res = await stub().fetch("https://do/poll", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 1, budgetSkipped: 0, denied: 0 });

    // Cognition saw the email as a direction.
    expect(kimi.requests).toHaveLength(1);
    const prompt = kimi.requests[0]!.messages.find((m) => m.role === "user")!.content;
    expect(prompt).toContain("Runway question");
    expect(prompt).toContain("How many months of runway remain?");
    expect(prompt).toContain("channel: gmail");

    // Evidence: one commit with the gmail direction artifact + trio.
    expect(gh.trees).toHaveLength(1);
    const paths = gh.trees[0]!.tree.map((t) => t.path).sort();
    expect(paths[1]).toMatch(/^reports\/\d{4}-\d{2}-\d{2}-chief-of-staff\.direction-[0-9a-f]{8}\.md$/);
    const artifact = gh.trees[0]!.tree.find((t) => t.path !== "ledger/actions.jsonl")!;
    expect(artifact.content).toContain("channel: gmail");

    // The reply went back to the sender, and only after the commit.
    expect(gmail.sentRaw).toHaveLength(1);
    const rfc822 = decodeB64Url(gmail.sentRaw[0]!);
    expect(rfc822).toContain("To: The Principal <principal@example.test>");
    expect(rfc822).toContain("Subject: Re: Runway question");
    expect(rfc822).toContain("About 14 months");

    // Mark-read confirmed; the id is remembered even beyond that.
    expect(gmail.modified).toHaveLength(1);
    const seen = await runInDurableObject(stub(), (_i, state) => state.storage.get<string[]>("gmail-processed"));
    expect(seen).toEqual(["m1"]);
  });

  it("an already-processed message id is never processed twice", async () => {
    await runInDurableObject(stub(), async (_i, state) => {
      await state.storage.put("gmail-processed", ["m1"]);
    });
    mockGmail({ tokens: 1, withReply: false }); // poll only — no cognition, no reply

    const res = await stub().fetch("https://do/poll", { method: "POST" });
    expect(await res.json()).toEqual({ processed: 0, budgetSkipped: 0, denied: 0 });
  });

  it("over-budget mail is left unread and unspent — eligible again tomorrow", async () => {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: env.BEAT_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    await runInDurableObject(stub(), async (_i, state) => {
      await state.storage.put(`count:${today}`, 3); // cap is 3 in test config
    });
    mockGmail({ tokens: 1, withReply: false });

    const res = await stub().fetch("https://do/poll", { method: "POST" });
    expect(await res.json()).toEqual({ processed: 0, budgetSkipped: 1, denied: 0 });

    // Not marked seen, not marked read: tomorrow's budget picks it up.
    const seen = await runInDurableObject(stub(), (_i, state) => state.storage.get<string[]>("gmail-processed"));
    expect(seen ?? []).toEqual([]);
  });

  it("the poll cadence re-arms the alarm after a cycle", async () => {
    mockGmail({ tokens: 1, withReply: false, unreadIds: [] });
    await runInDurableObject(stub(), async (_i, state) => {
      await state.storage.put("gmail-processed", []);
    });
    await stub().fetch("https://do/poll", { method: "POST" });
    const alarm = await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThan(Date.now());
    expect(alarm!).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1000);
  });
});
