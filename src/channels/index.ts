import type { DeliveryResult } from "./types.js";
import { deliverLatestReportFromStore } from "./registry.js";
import { FsInstanceStore } from "../instance/store-fs.js";

export type { DeliveryChannel, DeliveryMessage, DeliveryResult, ChannelContext } from "./types.js";
export { discordChannel } from "./discord.js";
export { notionChannel } from "./notion.js";
export { gmailChannel } from "./gmail.js";
export {
  consoleChannel,
  resolveChannel,
  registerChannel,
  reportToMessage,
  deliverMessage,
  deliverLatestReportFromStore,
  type DeliverFromStoreOptions,
} from "./registry.js";

export interface DeliverLatestOptions {
  agent?: string;
  channels?: string[];
  fetchImpl?: typeof fetch;
  log?: (note: string) => void;
}

/**
 * Deliver the newest report for an agent through the instance's configured
 * channels — the filesystem convenience wrapper (Node-only; Workers use
 * deliverLatestReportFromStore with an injected env).
 */
export async function deliverLatestReport(
  instanceRoot: string,
  options: DeliverLatestOptions = {},
): Promise<DeliveryResult[]> {
  return deliverLatestReportFromStore(new FsInstanceStore(instanceRoot), options);
}
