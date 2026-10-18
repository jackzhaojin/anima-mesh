import "../providers/node-providers.js"; // register subprocess providers (Node entrypoint)
import { FsInstanceStore } from "../instance/store-fs.js";
import { getEnv } from "../instance/env-core.js";
import { nodeSourceFs } from "../sources/local-files.js";
import { localMsGraphTokenManager } from "../sources/msgraph-auth-file.js";
import { localBrainOpener } from "../brains/local.js";
import type { AgentWorkerProvider } from "../providers/index.js";
import {
  findSlackMentions,
  slackIdList,
  slackSenderAllowed,
  postSlackMarkdown,
  slackApi,
  slackConversationContext,
  type SlackMention,
} from "../channels/slack.js";
import { runDirectionCore } from "./direction-core.js";

/**
 * Slack mentions on the laptop tier (v2.3.1) - the same direction pipeline
 * the Worker's /slack/events door feeds, for a brain with no cloud tier or
 * whose agents run on a subprocess harness the cloud cannot host. Polls the
 * channel(s) with the bot token instead of receiving pushed events, so it
 * needs no public endpoint and no signing secret.
 *
 * Same gates as the Worker, in code (slackSenderAllowed): SLACK_ALLOWED_USER_IDS
 * (absent = the listener refuses to start - nobody to answer; `*` = members
 * of the channels SLACK_ALLOWED_CHANNEL_IDS pins), channels from
 * SLACK_ALLOWED_CHANNEL_IDS or else SLACK_CHANNEL_ID, bot-authored messages
 * never heard. Dedup is the ledger itself: a mention whose ts already
 * appears as a slack `messageId` (started, failed, or denied) is done, so a
 * restart never answers twice and needs no cursor file.
 */

export interface SlackListenOptions {
  instanceRoot: string;
  /** How far back a pass looks for mentions. Default 60 minutes. */
  lookbackMinutes?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  provider?: AgentWorkerProvider;
  now?: () => Date;
  log?: (note: string) => void;
}

export interface SlackListenResult {
  answered: number;
  failed: number;
  denied: number;
}

const DEFAULT_LOOKBACK_MINUTES = 60;
const HANDLED_ACTIONS = new Set(["direction-started", "direction-failed", "direction-denied"]);

/** One pass: find new mentions, gate them, answer each in its thread. */
export async function slackListenOnce(options: SlackListenOptions): Promise<SlackListenResult> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const store = new FsInstanceStore(options.instanceRoot);
  const env = { ...process.env, ...store.instanceEnv() } as Record<string, string | undefined>;
  const api = { env, fetchImpl: options.fetchImpl };

  if (!getEnv(env, "SLACK_BOT_TOKEN")) throw new Error("slack listen: SLACK_BOT_TOKEN is not set");
  const gateEnv = {
    SLACK_ALLOWED_USER_IDS: getEnv(env, "SLACK_ALLOWED_USER_IDS"),
    SLACK_ALLOWED_CHANNEL_IDS: getEnv(env, "SLACK_ALLOWED_CHANNEL_IDS"),
  };
  if (slackIdList(gateEnv.SLACK_ALLOWED_USER_IDS).length === 0) {
    throw new Error("slack listen: SLACK_ALLOWED_USER_IDS is empty - nobody may direct the persona, so there is nothing to listen for");
  }
  const channels = slackIdList(getEnv(env, "SLACK_ALLOWED_CHANNEL_IDS") ?? getEnv(env, "SLACK_CHANNEL_ID"));
  if (channels.length === 0) throw new Error("slack listen: set SLACK_ALLOWED_CHANNEL_IDS (or SLACK_CHANNEL_ID)");

  const { user_id: botUserId } = await slackApi<{ user_id: string }>(api, "auth.test", {});
  const oldest = ((now().getTime() - (options.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES) * 60_000) / 1000).toFixed(6);
  const mentions = await findSlackMentions(api, { channels, botUserId, oldest });

  const handled = new Set(
    (await store.readLedger())
      .filter((e) => HANDLED_ACTIONS.has(e.action))
      .map((e) => e.detail as { channel?: string; messageId?: string } | undefined)
      .filter((d) => d?.channel === "slack" && d.messageId)
      .map((d) => d!.messageId!),
  );
  const fresh = mentions.filter((m) => !handled.has(m.ts));
  const result: SlackListenResult = { answered: 0, failed: 0, denied: 0 };
  const config = await store.loadConfig();
  const directionAgent = config.direction?.agent ?? config.delivery?.deliverAgent ?? "chief-of-staff";

  for (const m of fresh) {
    // Polled mentions are channel messages: the wildcard needs the channel
    // list pinned explicitly, same as the Worker's door.
    if (!slackSenderAllowed(gateEnv, { user: m.user, channel: m.channel, isDm: false })) {
      // Silent to the sender; evidence for the principal (once per message).
      await store.appendLedger({
        ts: now().toISOString(),
        runId: crypto.randomUUID(),
        agent: "channel-edge",
        action: "direction-denied",
        type: "report",
        detail: { channel: "slack", sender: m.user, messageId: m.ts },
      });
      result.denied++;
      log(`slack: denied mention from ${m.user} in ${m.channel}`);
      continue;
    }
    await answer(m);
  }
  return result;

  async function answer(m: SlackMention): Promise<void> {
    log(`slack: mention ${m.ts} from ${m.user} in ${m.channel}`);
    await slackApi(api, "reactions.add", { channel: m.channel, timestamp: m.ts, name: "eyes" }).catch((err) =>
      log(`slack: ack reaction failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    let context = "";
    try {
      context = await slackConversationContext(api, {
        channel: m.channel,
        ts: m.ts,
        ...(m.inThread ? { threadTs: m.threadTs } : {}),
        botUserId,
      });
    } catch (err) {
      log(`slack: context unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    const runId = crypto.randomUUID();
    let reply: string;
    try {
      const report = await runDirectionCore({
        store,
        message: {
          channel: "slack",
          sender: m.user,
          text: m.text,
          receivedAt: new Date(Number(m.ts) * 1000).toISOString(),
          messageId: m.ts,
          audience: "group",
          ...(context ? { context } : {}),
        },
        runId,
        providerCtx: { env, fetchImpl: options.fetchImpl },
        ...(options.provider ? { provider: options.provider } : {}),
        sourceFs: nodeSourceFs,
        msGraphToken: localMsGraphTokenManager(store.root, { env, fetchImpl: options.fetchImpl, log }),
        openLocalBrain: localBrainOpener(store.root),
        onProgress: log,
      });
      reply = report.reply;
      result.answered++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`slack: direction failed: ${message}`);
      // The sender's words must survive a provider failure (the Worker's rule).
      await store.appendLedger({
        ts: now().toISOString(),
        runId,
        agent: directionAgent,
        action: "direction-failed",
        type: "report",
        detail: { channel: "slack", sender: m.user, messageId: m.ts, text: m.text.slice(0, 1000), error: message.slice(0, 300) },
      });
      reply = `I couldn't think about that one (${message.slice(0, 300)}). Your message is recorded in the ledger and will surface in the next brief - no need to resend.`;
      result.failed++;
    }
    // Replies only follow evidence: the fs store wrote it already.
    if (reply.trim()) await postSlackMarkdown(api, { channel: m.channel, threadTs: m.threadTs }, reply);
  }
}
