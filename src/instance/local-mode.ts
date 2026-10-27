import type { InstanceConfig } from "./config-core.js";

/**
 * Local mode (v2.3.6): a brain whose knowledge never leaves the machine.
 *
 * For a brain that holds an employer's or client's proprietary knowledge,
 * the engine's reach is the risk: chat delivery, cloud mail and drive
 * readers, a remote store, web search queries, public engine issues. A
 * `"mode": "local"` config turns all of it off IN CODE, at the point each
 * capability would act, so no agent prompt or operator slip can reach it:
 *
 * - delivery: the console only (reports stay files in the brain);
 * - read sources: no OneDrive/Graph, Gmail, Google Calendar or Drive; the
 *   docs corpus only from a local path; linked brains only from local
 *   checkouts;
 * - web search: off, so no query text leaves through a model vendor's tool;
 * - engine feedback: drafts only, never filed to the public engine repo;
 * - runtime: never the cloud tier, never a `github:` remote instance, no
 *   Slack listener, no Google consent.
 *
 * What remains is the model call itself: the harness the principal chose
 * (a local CLI such as Claude Code, or an API) is the one network path, and
 * picking an approved one is the organization's decision, not the engine's.
 *
 * Workers-safe: no node imports.
 */

export const LOCAL_CHANNELS: readonly string[] = ["console"];
/** Read sources that always reach a network service. */
export const NETWORK_SOURCES: readonly string[] = ["onedrive", "gmail", "google-calendar", "google-drive"];

export function isLocalMode(config: InstanceConfig | undefined): boolean {
  return config?.mode === "local";
}

export class LocalModeViolation extends Error {
  constructor(what: string) {
    super(`local mode: ${what} is off for this brain (animamesh.config.json "mode": "local"; nothing leaves this machine)`);
    this.name = "LocalModeViolation";
  }
}

/** Throw when a local-mode brain reaches for `what`. */
export function assertNotLocal(config: InstanceConfig | undefined, what: string): void {
  if (isLocalMode(config)) throw new LocalModeViolation(what);
}

/** Delivery channels a local-mode brain may use; throws on any other. */
export function assertLocalChannels(config: InstanceConfig, channels: string[]): void {
  if (!isLocalMode(config)) return;
  const blocked = channels.filter((c) => !LOCAL_CHANNELS.includes(c));
  if (blocked.length > 0) throw new LocalModeViolation(`delivery to ${blocked.join(", ")}`);
}

/** The honest prompt section for a source local mode switched off; no fetch is made. */
export function localModeSourceSection(name: string): string {
  return `\n## Source '${name}'\n\n_(off: this brain runs in local mode, so the harness made no network call for it. Work from the bundle; do not guess at what this source would have said.)_`;
}

/** Config-level problems with a local-mode brain, for `validate`. */
export function localModeIssues(config: InstanceConfig): Array<{ level: "error" | "warning"; rule: string; message: string }> {
  if (!isLocalMode(config)) return [];
  const issues: Array<{ level: "error" | "warning"; rule: string; message: string }> = [];
  const blocked = (config.delivery?.channels ?? []).filter((c) => !LOCAL_CHANNELS.includes(c));
  if (blocked.length > 0) {
    issues.push({ level: "error", rule: "local/delivery", message: `delivery.channels lists ${blocked.join(", ")}; local mode delivers to the console only` });
  }
  for (const link of config.links ?? []) {
    if (!link.localPath) {
      issues.push({ level: "error", rule: "local/links", message: `link '${link.id}' has no localPath; local mode reads linked brains only from local checkouts` });
    }
  }
  if ((config.direction?.gmail?.pollMinutes ?? 0) > 0) {
    issues.push({ level: "error", rule: "local/gmail", message: "direction.gmail.pollMinutes is set; local mode reads no mail" });
  }
  return issues;
}
