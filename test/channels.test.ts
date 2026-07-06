import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { makeTree, concept } from "./helpers.js";
import { loadInstanceEnv } from "../src/instance/env.js";
import {
  discordChannel,
  notionChannel,
  gmailChannel,
  consoleChannel,
  resolveChannel,
  deliverLatestReport,
} from "../src/channels/index.js";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

/** fetch stub that records calls and returns scripted responses in order. */
function fakeFetch(...responses: Array<{ status?: number; json?: unknown; text?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)] ?? {};
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? "",
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

describe("env loader", () => {
  it("parses KEY=VALUE, strips quotes, ignores comments, .env.local wins", async () => {
    const root = await makeTree({
      ".env": 'A=1\nB="two"\n# comment\nC=base\n',
      ".env.local": "C='local'\nD=4\nnot a line\n",
    });
    roots.push(root);
    const env = loadInstanceEnv(root);
    expect(env).toEqual({ A: "1", B: "two", C: "local", D: "4" });
  });
});

describe("discord channel", () => {
  const env = { DISCORD_WEBHOOK_URL: "https://discord.example/hook" };

  it("assertConfigured names the missing var", () => {
    expect(() => discordChannel.assertConfigured({ env: {} })).toThrow(/DISCORD_WEBHOOK_URL/);
    expect(() => discordChannel.assertConfigured({ env })).not.toThrow();
  });

  it("posts title+body as content with the persona as username", async () => {
    const { impl, calls } = fakeFetch({ status: 204 });
    const result = await discordChannel.deliver(
      { title: "Daily Brief", body: "All quiet.", sender: "Vesper" },
      { env, fetchImpl: impl },
    );
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe(env.DISCORD_WEBHOOK_URL);
    const payload = JSON.parse(String(calls[0]!.init.body));
    expect(payload.content).toContain("**Daily Brief**");
    expect(payload.content).toContain("All quiet.");
    expect(payload.username).toBe("Vesper");
  });

  it("truncates over the 2000-char Discord limit with a repo pointer", async () => {
    const { impl, calls } = fakeFetch({ status: 204 });
    await discordChannel.deliver({ title: "T", body: "x".repeat(5000) }, { env, fetchImpl: impl });
    const payload = JSON.parse(String(calls[0]!.init.body));
    expect(payload.content.length).toBeLessThanOrEqual(2000);
    expect(payload.content).toContain("truncated");
  });

  it("surfaces webhook failures", async () => {
    const { impl } = fakeFetch({ status: 429, text: "rate limited" });
    await expect(
      discordChannel.deliver({ title: "T", body: "b" }, { env, fetchImpl: impl }),
    ).rejects.toThrow(/HTTP 429/);
  });

  it("bot-DM mode: accepts token+user config, opens the DM channel, sends as the bot", async () => {
    const dmEnv = { DISCORD_BOT_TOKEN: "bot-tok", DISCORD_DM_USER_ID: "principal-1" };
    expect(() => discordChannel.assertConfigured({ env: dmEnv })).not.toThrow();
    // empty webhook value falls through to bot-DM, not an error
    expect(() => discordChannel.assertConfigured({ env: { DISCORD_WEBHOOK_URL: "", ...dmEnv } })).not.toThrow();

    const { impl, calls } = fakeFetch({ status: 200, json: { id: "dm-chan-9" } }, { status: 200 });
    const result = await discordChannel.deliver({ title: "Brief", body: "hello" }, { env: dmEnv, fetchImpl: impl });
    expect(result.detail).toContain("bot DM");
    expect(calls[0]!.url).toContain("/users/@me/channels");
    expect(JSON.parse(String(calls[0]!.init.body)).recipient_id).toBe("principal-1");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bot bot-tok");
    expect(calls[1]!.url).toContain("/channels/dm-chan-9/messages");
    expect(JSON.parse(String(calls[1]!.init.body)).content).toContain("Brief");
  });

  it("bot-DM mode surfaces DM-open failures", async () => {
    const dmEnv = { DISCORD_BOT_TOKEN: "bot-tok", DISCORD_DM_USER_ID: "u" };
    const { impl } = fakeFetch({ status: 403, text: "cannot DM" });
    await expect(
      discordChannel.deliver({ title: "T", body: "b" }, { env: dmEnv, fetchImpl: impl }),
    ).rejects.toThrow(/DM open → HTTP 403/);
  });
});

describe("notion channel", () => {
  const env = { NOTION_API_KEY: "secret", NOTION_DATABASE_ID: "db-1" };

  it("assertConfigured names missing vars", () => {
    expect(() => notionChannel.assertConfigured({ env: {} })).toThrow(/NOTION_API_KEY/);
    expect(() => notionChannel.assertConfigured({ env: { NOTION_API_KEY: "k" } })).toThrow(/NOTION_DATABASE_ID/);
  });

  it("creates a page with title property and chunked paragraph blocks", async () => {
    const { impl, calls } = fakeFetch({ status: 200 });
    await notionChannel.deliver({ title: "Brief", body: "y".repeat(4000) }, { env, fetchImpl: impl });
    const payload = JSON.parse(String(calls[0]!.init.body));
    expect(payload.parent.database_id).toBe("db-1");
    expect(payload.properties.Name.title[0].text.content).toBe("Brief");
    expect(payload.children.length).toBeGreaterThanOrEqual(3); // 4000 chars / 1800 + …
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["Notion-Version"]).toBeTruthy();
  });

  it("surfaces API errors with body text", async () => {
    const { impl } = fakeFetch({ status: 401, text: "unauthorized" });
    await expect(notionChannel.deliver({ title: "T", body: "b" }, { env, fetchImpl: impl })).rejects.toThrow(
      /HTTP 401 unauthorized/,
    );
  });
});

describe("gmail channel", () => {
  const env = {
    GMAIL_CLIENT_ID: "cid",
    GMAIL_CLIENT_SECRET: "cs",
    GMAIL_REFRESH_TOKEN: "rt",
    AGENT_EMAIL: "persona@example.com",
  };

  it("assertConfigured names each missing var", () => {
    expect(() => gmailChannel.assertConfigured({ env: {} })).toThrow(/GMAIL_CLIENT_ID/);
    expect(() => gmailChannel.assertConfigured({ env })).not.toThrow();
  });

  it("refreshes the token then sends base64url RFC822 to the recipient", async () => {
    const { impl, calls } = fakeFetch({ status: 200, json: { access_token: "at-123" } }, { status: 200 });
    const result = await gmailChannel.deliver(
      { title: "Brief", body: "hello", sender: "Vesper", recipient: "principal@example.com" },
      { env, fetchImpl: impl },
    );
    expect(result.detail).toContain("principal@example.com");
    expect(calls[0]!.url).toContain("oauth2.googleapis.com/token");
    expect(String(calls[0]!.init.body)).toContain("grant_type=refresh_token");
    expect(calls[1]!.url).toContain("gmail/v1/users/me/messages/send");
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at-123");
    const { raw } = JSON.parse(String(calls[1]!.init.body));
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("From: Vesper <persona@example.com>");
    expect(decoded).toContain("To: principal@example.com");
    expect(decoded).toContain("Subject: Brief");
  });

  it("requires a recipient", async () => {
    await expect(gmailChannel.deliver({ title: "T", body: "b" }, { env })).rejects.toThrow(/no recipient/);
  });
});

describe("registry + deliverLatestReport", () => {
  it("resolves known channels, throws on unknown", () => {
    expect(resolveChannel("discord").name).toBe("discord");
    expect(resolveChannel("console").name).toBe("console");
    expect(() => resolveChannel("pigeon")).toThrow(/unknown channel 'pigeon'/);
  });

  it("delivers the NEWEST report for the configured agent with persona + principal wired", async () => {
    const root = await makeTree({
      "animamesh.config.json": JSON.stringify({
        bundle: "bundle",
        identity: { principal: { name: "Pat", email: "pat@example.com" }, persona: { name: "Vesper" } },
        delivery: { channels: ["discord"], deliverAgent: "scout" },
      }),
      "bundle/index.md": concept("index", {}, "# I"),
      "bundle/log.md": concept("log", {}, "# L"),
      "bundle/constitution.md": concept("constitution", { immutable: true }, "# C"),
      "reports/2026-07-01-scout-aaa.md": "---\ntype: report\n---\n\n# Old brief\n\nold",
      "reports/2026-07-05-scout-bbb.md": "---\ntype: report\n---\n\n# New brief\n\nfresh content",
      "reports/2026-07-06-other-ccc.md": "---\ntype: report\n---\n\n# Wrong agent\n\nnope",
      ".env.local": "DISCORD_WEBHOOK_URL=https://discord.example/hook\n",
    });
    roots.push(root);
    const { impl, calls } = fakeFetch({ status: 204 });
    const results = await deliverLatestReport(root, { fetchImpl: impl });
    expect(results).toHaveLength(1);
    const payload = JSON.parse(String(calls[0]!.init.body));
    expect(payload.content).toContain("New brief");
    expect(payload.content).not.toContain("Wrong agent");
    expect(payload.username).toBe("Vesper");
  });

  it("throws clearly when the agent has no reports", async () => {
    const root = await makeTree({
      "animamesh.config.json": JSON.stringify({ bundle: "bundle" }),
      "bundle/index.md": concept("index", {}, "# I"),
      "bundle/log.md": concept("log", {}, "# L"),
      "reports/.gitkeep": "",
    });
    roots.push(root);
    await expect(deliverLatestReport(root, { agent: "ghost", channels: ["console"] })).rejects.toThrow(
      /no reports found for agent 'ghost'/,
    );
  });

  it("console channel is the zero-setup default", async () => {
    const lines: string[] = [];
    const result = await consoleChannel.deliver({ title: "T", body: "b" }, { env: {}, log: (s) => lines.push(s) });
    expect(result.ok).toBe(true);
    expect(lines.join("")).toContain("T");
  });
});
