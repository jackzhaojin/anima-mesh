import { describe, it, expect, vi } from "vitest";
import { pollGmailInbox, markGmailRead } from "../src/channels/gmail.js";

/**
 * Inbound Gmail against a scripted API: query shape, sender re-check,
 * multipart body extraction, and the mark-read confirmation. (The send path
 * stays covered in channels.test.ts; the full poll→direction→reply flow is
 * a workerd test in workers/heartbeat/test/.)
 */

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function gmailFetch(overrides: Record<string, (url: string, init?: RequestInit) => Response> = {}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    for (const [prefix, handler] of Object.entries(overrides)) {
      if (url.includes(prefix)) return handler(url, init);
    }
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "at-1" });
    if (url.includes("/messages?q=")) return Response.json({ messages: [{ id: "m1" }] });
    if (url.includes("/messages/m1?format=full")) {
      return Response.json({
        id: "m1",
        internalDate: "1783300000000",
        payload: {
          headers: [
            { name: "From", value: "The Principal <principal@example.test>" },
            { name: "Subject", value: "Runway question" },
          ],
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/html", body: { data: b64url("<p>ignore me</p>") } },
            { mimeType: "text/plain", body: { data: b64url("How many months of runway do we have?") } },
          ],
        },
      });
    }
    if (url.includes("/messages/m1/modify")) return Response.json({ id: "m1" });
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const ENV = {
  GMAIL_CLIENT_ID: "c",
  GMAIL_CLIENT_SECRET: "s",
  GMAIL_REFRESH_TOKEN: "r",
  AGENT_EMAIL: "persona@example.test",
};

describe("pollGmailInbox", () => {
  it("queries unread-from-sender, extracts the text/plain part, parses headers", async () => {
    const mock = gmailFetch();
    const emails = await pollGmailInbox({ env: ENV, fetchImpl: mock.fetchImpl }, { allowedFrom: "principal@example.test" });

    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      id: "m1",
      from: "The Principal <principal@example.test>",
      subject: "Runway question",
      text: "How many months of runway do we have?",
    });
    expect(emails[0]!.receivedAt).toBe(new Date(1783300000000).toISOString());

    const listCall = mock.calls.find((c) => c.url.includes("/messages?q="))!;
    expect(decodeURIComponent(listCall.url)).toContain("from:principal@example.test is:unread in:inbox");
  });

  it("re-checks the From header client-side — a loose query match is dropped", async () => {
    const mock = gmailFetch({
      "?format=full": () =>
        Response.json({
          id: "m1",
          payload: { headers: [{ name: "From", value: "spoofer@evil.test" }], body: { data: b64url("hi") } },
        }),
    });
    const emails = await pollGmailInbox({ env: ENV, fetchImpl: mock.fetchImpl }, { allowedFrom: "principal@example.test" });
    expect(emails).toEqual([]);
  });

  it("refuses to poll without an allowlist — inbound is never open", async () => {
    const mock = gmailFetch();
    await expect(pollGmailInbox({ env: ENV, fetchImpl: mock.fetchImpl }, { allowedFrom: "" })).rejects.toThrow(
      /allowlist-only/,
    );
  });

  it("one unreadable message never kills the poll", async () => {
    const mock = gmailFetch({
      "/messages?q=": () => Response.json({ messages: [{ id: "bad" }, { id: "m1" }] }),
      "/messages/bad?format=full": () => new Response("boom", { status: 500 }),
    });
    const emails = await pollGmailInbox({ env: ENV, fetchImpl: mock.fetchImpl }, { allowedFrom: "principal@example.test" });
    expect(emails.map((e) => e.id)).toEqual(["m1"]);
  });
});

describe("markGmailRead", () => {
  it("drops the UNREAD label — the poll's dedup contract", async () => {
    const mock = gmailFetch();
    await markGmailRead({ env: ENV, fetchImpl: mock.fetchImpl }, "m1");
    const modify = mock.calls.find((c) => c.url.includes("/modify"))!;
    expect(modify.method).toBe("POST");
    expect(JSON.parse(modify.body!)).toEqual({ removeLabelIds: ["UNREAD"] });
  });
});
