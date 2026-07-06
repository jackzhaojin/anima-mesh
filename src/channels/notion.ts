import type { DeliveryChannel, DeliveryMessage, ChannelContext, DeliveryResult } from "./types.js";
import { getEnv } from "../instance/env.js";

/**
 * Notion delivery: creates a page in a database (NOTION_DATABASE_ID) with the
 * report as paragraph blocks. Requires NOTION_API_KEY. Blocks are chunked to
 * Notion's ~2000-char rich-text limit.
 */
const NOTION_VERSION = "2022-06-28";
const BLOCK_CHAR_LIMIT = 1800;
const MAX_BLOCKS = 50;

export const notionChannel: DeliveryChannel = {
  name: "notion",

  assertConfigured(ctx: ChannelContext): void {
    if (!getEnv(ctx.env, "NOTION_API_KEY")) throw new Error("notion channel: NOTION_API_KEY is not set");
    if (!getEnv(ctx.env, "NOTION_DATABASE_ID")) throw new Error("notion channel: NOTION_DATABASE_ID is not set");
  },

  async deliver(msg: DeliveryMessage, ctx: ChannelContext): Promise<DeliveryResult> {
    const key = getEnv(ctx.env, "NOTION_API_KEY")!;
    const databaseId = getEnv(ctx.env, "NOTION_DATABASE_ID")!;
    const doFetch = ctx.fetchImpl ?? fetch;

    const chunks: string[] = [];
    for (let i = 0; i < msg.body.length && chunks.length < MAX_BLOCKS; i += BLOCK_CHAR_LIMIT) {
      chunks.push(msg.body.slice(i, i + BLOCK_CHAR_LIMIT));
    }
    const truncated = msg.body.length > BLOCK_CHAR_LIMIT * MAX_BLOCKS;

    const res = await doFetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties: {
          Name: { title: [{ text: { content: msg.title } }] },
        },
        children: [
          ...chunks.map((chunk) => ({
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
          })),
          ...(truncated
            ? [{
                object: "block",
                type: "paragraph",
                paragraph: { rich_text: [{ type: "text", text: { content: "…(truncated — full report lives in the brain repo)" } }] },
              }]
            : []),
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`notion pages.create → HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
    }
    return { channel: "notion", ok: true, detail: `page created (${chunks.length} block(s))` };
  },
};
