import type { DeliveryChannel, DeliveryMessage, DeliveryResult, ChannelContext } from "./types.js";
import { discordChannel } from "./discord.js";
import { notionChannel } from "./notion.js";
import { gmailChannel } from "./gmail.js";
import { parseConcept } from "../okf/frontmatter.js";
import type { InstanceConfig } from "../instance/config-core.js";
import type { InstanceStore } from "../instance/store.js";

/**
 * Channel registry + store-based delivery — Workers-safe. All bundled
 * channels are pure fetch with injected env; the fs-coupled
 * deliverLatestReport wrapper lives in channels/index.ts.
 */

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

/** Raw report file → deliverable message (title from first heading). */
export function reportToMessage(raw: string, fallbackTitle: string, config: InstanceConfig): DeliveryMessage {
  const parsed = parseConcept(raw);
  const body = (parsed?.body ?? raw).trim();
  const heading = body.split("\n").find((l) => l.startsWith("# "));
  return {
    title: heading ? heading.replace(/^#\s*/, "") : fallbackTitle,
    body,
    sender: config.identity?.persona?.name,
    recipient: config.identity?.principal.email,
  };
}

/** Deliver one message through named channels with an injected context. */
export async function deliverMessage(
  msg: DeliveryMessage,
  channelNames: string[],
  ctx: ChannelContext,
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (const name of channelNames) {
    const channel = resolveChannel(name);
    channel.assertConfigured(ctx);
    results.push(await channel.deliver(msg, ctx));
  }
  return results;
}

export interface DeliverFromStoreOptions {
  agent?: string;
  channels?: string[];
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (note: string) => void;
}

/**
 * Deliver the newest report for an agent, reading through the store —
 * works identically over a local directory or a remote repo. The report
 * artifact stays the source of truth; delivery is a courtesy copy.
 */
export async function deliverLatestReportFromStore(
  store: InstanceStore,
  options: DeliverFromStoreOptions = {},
): Promise<DeliveryResult[]> {
  const config = await store.loadConfig();
  const agent = options.agent ?? config.delivery?.deliverAgent ?? "chief-of-staff";
  const channelNames = options.channels ?? config.delivery?.channels ?? ["console"];

  const candidates = (await store.listReports()).filter((f) => f.includes(`-${agent}-`));
  const newest = candidates[candidates.length - 1];
  if (!newest) throw new Error(`no reports found for agent '${agent}'`);

  const raw = await store.readReport(newest);
  const msg = reportToMessage(raw, newest.replace(/\.md$/, ""), config);
  const ctx: ChannelContext = {
    env: options.env ?? store.instanceEnv?.() ?? {},
    fetchImpl: options.fetchImpl,
    log: options.log,
  };
  return deliverMessage(msg, channelNames, ctx);
}
