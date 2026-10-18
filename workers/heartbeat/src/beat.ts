import { GitHubInstanceStore } from "../../../src/instance/store-github.js";
import { githubToken } from "../../../src/instance/github-auth.js";
import { heartbeatCore } from "../../../src/harness/heartbeat-core.js";
import { dateStampFor } from "../../../src/harness/run-core.js";
import { deliverLatestReportFromStore, deliverMessage, resolveChannel } from "../../../src/channels/registry.js";
import { envRecord, type Env } from "./env.js";
import { cloudMsGraphToken } from "./msgraph-token.js";

/**
 * One cloud beat: the same heartbeat the laptop runs, over the GitHub-hosted
 * brain and API cognition only. Agents on subprocess harnesses are skipped
 * with reason (cloudTier) — honest reporting, not a bug.
 */
export interface BeatSummary {
  date: string;
  due: number;
  ran: number;
  skipped: number;
  failures: Array<{ agent: string; error: string }>;
  commitSha?: string;
  delivered: boolean;
  deliveryDetail?: string;
  /** Summed provider usage across the beat's runs — spend visibility on /healthz. */
  tokens?: { input: number; output: number };
}

export async function runCloudBeat(env: Env, log: (note: string) => void = console.log): Promise<BeatSummary> {
  const record = envRecord(env);
  const date = dateStampFor(new Date(), env.BEAT_TIMEZONE);
  let stage = "init";
  // The brain's delivery channels, once its config is readable - where a
  // failure alert goes. Unknown (the beat died first) = every chat channel
  // this Worker has credentials for.
  let configuredChannels: string[] | undefined;

  try {
    stage = "store";
    log("beat stage: store");
    const store = new GitHubInstanceStore({
      repo: env.BRAIN_REPO,
      ref: env.BRAIN_REF,
      token: await githubToken(record),
    });

    stage = "heartbeat";
    log("beat stage: heartbeat");
    const result = await heartbeatCore({
      store,
      cloudTier: true,
      providerCtx: { env: record },
      msGraphToken: cloudMsGraphToken(env),
      flushPolicy: "caller", // one commit per beat, not per run
      timeZone: env.BEAT_TIMEZONE,
      onProgress: log, // console → wrangler tail
    });

    configuredChannels = (await store.loadConfig()).delivery?.channels;

    stage = "flush";
    log("beat stage: flush");
    const { commitSha } = await store.flush(
      `beat(cloud): ${date} — ${result.runs.length} run(s), ${result.failures.length} failure(s)`,
    );

    stage = "deliver";
    log("beat stage: deliver");
    let delivered = false;
    let deliveryDetail: string | undefined;
    if (result.runs.length > 0) {
      try {
        const results = await deliverLatestReportFromStore(store, { env: record, log });
        delivered = results.every((r) => r.ok);
        deliveryDetail = results.map((r) => `${r.channel}:${r.ok ? "ok" : r.detail}`).join(", ");
      } catch (err) {
        deliveryDetail = `delivery failed: ${err instanceof Error ? err.message : String(err)}`;
        log(deliveryDetail);
      }
    } else {
      deliveryDetail = "nothing ran (all skipped or already done today) — no delivery";
    }

    // Silence must mean success — for SPOKE failures too, not just a dead
    // beat. Without this, a morning where every due agent fails delivers
    // nothing and reads exactly like a quiet "nothing due" day.
    if (result.failures.length > 0) {
      const lines = result.failures.map((f) => `${f.agent}: ${f.error.slice(0, 200)}`).join("\n");
      await attemptFailureAlert(
        record,
        configuredChannels,
        `⚠️ cloud beat ${date}: ${result.failures.length}/${result.due.length} due agent(s) failed\n${lines}`.slice(0, 1500),
        log,
      );
    }

    let tokens: BeatSummary["tokens"];
    for (const run of result.runs) {
      if (!run.tokens) continue;
      tokens ??= { input: 0, output: 0 };
      tokens.input += run.tokens.input ?? 0;
      tokens.output += run.tokens.output ?? 0;
    }
    if (tokens) log(`beat tokens: ${tokens.input} in / ${tokens.output} out across ${result.runs.length} run(s)`);

    return {
      date,
      due: result.due.length,
      ran: result.runs.length,
      skipped: result.skipped.length,
      failures: result.failures,
      commitSha,
      delivered,
      deliveryDetail,
      tokens,
    };
  } catch (err) {
    // Silence must mean success: a beat-level failure still attempts a DM.
    const message = err instanceof Error ? err.message : String(err);
    await attemptFailureAlert(record, configuredChannels, `⚠️ cloud beat failed at ${stage}: ${message.slice(0, 500)}`, log);
    throw err;
  }
}

/** Chat channels that can carry a failure alert (never console/notion/gmail). */
const ALERT_CHANNELS = ["slack", "discord"];

/**
 * Which channels a failure alert goes to: the brain's own chat delivery
 * channels when its config was read, else (config unknown, or it names no
 * chat channel) every chat channel with credentials here. A Slack-only
 * brain alerts in Slack; a brain migrated off Discord stops hearing from it
 * there (v2.3.2 - alerts were Discord-only before).
 */
export function failureAlertChannels(
  record: Record<string, string | undefined>,
  configured: string[] | undefined,
): string[] {
  const chat = (configured ?? []).filter((c) => ALERT_CHANNELS.includes(c));
  const candidates = chat.length > 0 ? chat : ALERT_CHANNELS;
  return candidates.filter((name) => {
    try {
      resolveChannel(name).assertConfigured({ env: record });
      return true;
    } catch {
      return false;
    }
  });
}

async function attemptFailureAlert(
  record: Record<string, string | undefined>,
  configured: string[] | undefined,
  body: string,
  log: (note: string) => void,
): Promise<void> {
  for (const channel of failureAlertChannels(record, configured)) {
    try {
      await deliverMessage({ title: "cloud beat failed", body }, [channel], { env: record, log });
    } catch {
      log(`failure alert could not be delivered via ${channel} either`);
    }
  }
}
