import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { DeliveryChannel, DeliveryMessage, DeliveryResult, ChannelContext } from "./types.js";
import { discordChannel } from "./discord.js";
import { notionChannel } from "./notion.js";
import { gmailChannel } from "./gmail.js";
import { loadInstanceEnv } from "../instance/env.js";
import { loadInstance } from "../instance/config.js";
import { parseConcept } from "../okf/frontmatter.js";

export type { DeliveryChannel, DeliveryMessage, DeliveryResult, ChannelContext } from "./types.js";
export { discordChannel } from "./discord.js";
export { notionChannel } from "./notion.js";
export { gmailChannel } from "./gmail.js";

/** Console channel: prints; always configured. The zero-setup default. */
export const consoleChannel: DeliveryChannel = {
  name: "console",
  assertConfigured(): void {
    /* always */
  },
  async deliver(msg: DeliveryMessage, ctx: ChannelContext): Promise<DeliveryResult> {
    (ctx.log ?? console.log)(`\n=== ${msg.title} ===\n\n${msg.body}\n`);
    return { channel: "console", ok: true, detail: "printed" };
  },
};

const registry = new Map<string, DeliveryChannel>([
  ["discord", discordChannel],
  ["notion", notionChannel],
  ["gmail", gmailChannel],
  ["console", consoleChannel],
]);

export function resolveChannel(name: string): DeliveryChannel {
  const channel = registry.get(name);
  if (!channel) throw new Error(`unknown channel '${name}' — registered: ${[...registry.keys()].join(", ")}`);
  return channel;
}

export function registerChannel(channel: DeliveryChannel, name = channel.name): void {
  registry.set(name, channel);
}

export interface DeliverLatestOptions {
  agent?: string;
  channels?: string[];
  fetchImpl?: typeof fetch;
  log?: (note: string) => void;
}

/**
 * Deliver the newest report for an agent through the instance's configured
 * channels. The report artifact stays the source of truth; delivery is a
 * courtesy copy to the principal's sanctioned surfaces.
 */
export async function deliverLatestReport(
  instanceRoot: string,
  options: DeliverLatestOptions = {},
): Promise<DeliveryResult[]> {
  const instance = loadInstance(instanceRoot);
  const agent = options.agent ?? instance.config.delivery?.deliverAgent ?? "chief-of-staff";
  const channelNames = options.channels ?? instance.config.delivery?.channels ?? ["console"];

  if (!existsSync(instance.reportsDir)) throw new Error(`no reports directory at ${instance.reportsDir}`);
  const candidates = readdirSync(instance.reportsDir)
    .filter((f) => f.endsWith(".md") && f.includes(`-${agent}-`))
    .sort();
  const newest = candidates[candidates.length - 1];
  if (!newest) throw new Error(`no reports found for agent '${agent}' in ${instance.reportsDir}`);

  const raw = readFileSync(path.join(instance.reportsDir, newest), "utf8");
  const parsed = parseConcept(raw);
  const body = (parsed?.body ?? raw).trim();
  const heading = body.split("\n").find((l) => l.startsWith("# "));
  const title = heading ? heading.replace(/^#\s*/, "") : newest.replace(/\.md$/, "");

  const msg: DeliveryMessage = {
    title,
    body,
    sender: instance.config.identity?.persona?.name,
    recipient: instance.config.identity?.principal.email,
  };
  const ctx: ChannelContext = {
    env: loadInstanceEnv(instance.root),
    fetchImpl: options.fetchImpl,
    log: options.log,
  };

  const results: DeliveryResult[] = [];
  for (const name of channelNames) {
    const channel = resolveChannel(name);
    channel.assertConfigured(ctx);
    results.push(await channel.deliver(msg, ctx));
  }
  return results;
}
