import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/env.js";

/**
 * Workerd-safe fixtures: a raw (uncompressed) tar of a minimal brain — the
 * store's gunzip() passes non-gzip bytes through, so tests skip gzip
 * entirely — plus fetchMock scripting for the three outbound services a
 * beat touches (GitHub, Kimi, Discord).
 *
 * Interceptors are one-shot with EXACT call counts (never .persist():
 * persisted interceptors leak across tests in the single-worker pool).
 * Tests end with fetchMock.assertNoPendingInterceptors() — the mock plan
 * IS the expected traffic, so a missed call fails loudly.
 */

// ---- DO state hygiene -------------------------------------------------------

/**
 * Fresh DO state per test (isolatedStorage is off — see vitest.config.ts):
 * deleteAll() clears keys; the alarm is separate state with its own delete.
 * The first stub call after a module-graph reload can land on an invalidated
 * DO ("src changed … please retry") — retried once with a fresh stub.
 */
export async function wipeHeartbeatDo(): Promise<void> {
  const e = env as Env;
  await wipeDo(() => e.HEARTBEAT_DO.get(e.HEARTBEAT_DO.idFromName("main")));
  await wipeDo(() => e.DIRECTION_DO.get(e.DIRECTION_DO.idFromName("main")));
}

async function wipeDo(makeStub: () => DurableObjectStub): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await runInDurableObject(makeStub(), async (_i, state) => {
        await state.storage.deleteAll();
        await state.storage.deleteAlarm();
      });
      return;
    } catch (err) {
      if (attempt === 0 && String(err).includes("invalidating this Durable Object")) continue;
      throw err;
    }
  }
}

// ---- Discord interaction signing (TEST-ONLY keypair) ------------------------

/**
 * The private half of the TEST-ONLY Ed25519 keypair whose public half sits
 * in vitest.config.ts as DISCORD_PUBLIC_KEY. Gates nothing real anywhere.
 */
const TEST_DISCORD_PRIVATE_PKCS8_B64 = "MC4CAQAwBQYDK2VwBCIEIL6Kzp/A0umM4XdgxBxtXPTLPdWi7e+rSFUvyR+sGdY+";

/** Build a correctly signed Discord interaction request. */
export async function signedInteraction(payload: unknown, url = "https://worker.test/interactions"): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = Uint8Array.from(atob(TEST_DISCORD_PRIVATE_PKCS8_B64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", raw, { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(timestamp + body)));
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": [...sig].map((b) => b.toString(16).padStart(2, "0")).join(""),
      "x-signature-timestamp": timestamp,
    },
    body,
  });
}

/** A principal-sent slash command carrying free text. */
export function principalCommand(text: string, senderId = "42"): unknown {
  return {
    type: 2,
    id: `inter-${text.length}-${senderId}`,
    application_id: "app-1",
    token: "tok-1",
    data: { name: "direct", options: [{ name: "message", type: 3, value: text }] },
    member: { user: { id: senderId } },
  };
}

export interface FollowupScript {
  contents: string[];
}

/** Script `times` interaction-followup webhook posts into one capture. */
export function mockDiscordFollowup(times = 1): FollowupScript {
  const script: FollowupScript = { contents: [] };
  fetchMock
    .get("https://discord.com")
    .intercept({ method: "POST", path: "/api/v10/webhooks/app-1/tok-1" })
    .reply(200, (req) => {
      script.contents.push((JSON.parse(req.body as string) as { content: string }).content);
      return { id: "followup-1" };
    })
    .times(times);
  return script;
}

// ---- raw tar builder --------------------------------------------------------

function tarEntry(name: string, content: string): Uint8Array {
  const data = new TextEncoder().encode(content);
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name), 0); // name (≤100 chars here)
  header.set(enc.encode("0000644\0"), 100); // mode
  header.set(enc.encode("0000000\0"), 108); // uid
  header.set(enc.encode("0000000\0"), 116); // gid
  header.set(enc.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124); // size
  header.set(enc.encode("00000000000\0"), 136); // mtime
  header.set(enc.encode("        "), 148); // checksum placeholder
  header[156] = 0x30; // typeflag '0' = regular file
  header.set(enc.encode("ustar\0"), 257);
  header.set(enc.encode("00"), 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  const padded = new Uint8Array(512 + Math.ceil(data.length / 512) * 512);
  padded.set(header, 0);
  padded.set(data, 512);
  return padded;
}

export function buildTar(files: Record<string, string>, topDir = "owner-brain-abc1234"): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [rel, content] of Object.entries(files)) {
    parts.push(tarEntry(`${topDir}/${rel}`, content));
  }
  parts.push(new Uint8Array(1024)); // two zero blocks end the archive
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---- the fixture brain ------------------------------------------------------

export const BASE_SHA = "a".repeat(40);
export const NEW_SHA = "b".repeat(40);

function concept(type: string, extra: Record<string, unknown>, body: string): string {
  const fm = [`type: ${type}`];
  for (const [k, v] of Object.entries(extra)) {
    fm.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return `---\n${fm.join("\n")}\n---\n\n${body}\n`;
}

/**
 * A minimal brain with one cloud-capable agent (moonshot-api, daily, last
 * ran 2026-01-01 → due today) and one laptop-tier agent (claude-code → the
 * cloud beat must skip it with reason). Delivery: discord bot-DM.
 */
export function brainFiles(): Record<string, string> {
  return {
    "animamesh.config.json": JSON.stringify({
      bundle: "bundle",
      delivery: { deliverAgent: "chief-of-staff", channels: ["discord"] },
    }),
    "bundle/index.md": concept("index", { title: "Test Mesh" }, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "bundle/ops/calendar.md": concept("calendar", {}, "# Calendar\n\n- 2026-09-15: annual return\n"),
    "bundle/agents/chief-of-staff.md": concept(
      "agent",
      { name: "chief-of-staff", title: "Chief of Staff", level: "L1", model: "kimi-for-coding", harness: "moonshot-api", heartbeat: "daily" },
      "Wake daily, write the principal's brief.",
    ),
    "bundle/agents/librarian.md": concept(
      "agent",
      { name: "librarian", title: "Librarian", level: "L1", model: "sonnet", harness: "claude-code", heartbeat: "daily" },
      "Laptop-tier: catalog the filing cabinet.",
    ),
    "ledger/actions.jsonl":
      JSON.stringify({ ts: "2026-01-01T00:00:00Z", runId: "old", agent: "chief-of-staff", action: "run-completed", type: "report" }) + "\n",
    "reports/2026-01-01-chief-of-staff-old00000.md": "---\ntype: report\n---\n\n# Old brief\n\nold\n",
  };
}

// ---- scripted services ------------------------------------------------------

export interface GitHubScript {
  /** Captured POST /git/trees bodies (one per flush attempt). */
  trees: Array<{ tree: Array<{ path: string; content: string; mode: string }>; base_tree: string }>;
  /** Captured POST /git/commits bodies. */
  commits: Array<{ message: string; parents: string[]; author: { name: string } }>;
  /** Captured PATCH refs bodies. */
  patches: Array<{ sha: string; force: boolean }>;
}

export interface MockGitHubOptions {
  files?: Record<string, string>;
  /**
   * Whether this test's traffic includes a flush (dirty writes → commit).
   * A flushing beat: ref ×2 (snapshot + flush re-check), tarball, commit
   * base, trees, commit, patch-ref. A read-only pass: ref ×1 + tarball.
   */
  flush?: boolean;
}

/** Script the GitHub API for exactly one snapshot (and one flush when asked). */
export function mockGitHub(opts: MockGitHubOptions = {}): GitHubScript {
  const script: GitHubScript = { trees: [], commits: [], patches: [] };
  const tar = buildTar(opts.files ?? brainFiles());
  const flush = opts.flush ?? true;
  const gh = fetchMock.get("https://api.github.com");

  gh.intercept({ method: "GET", path: "/repos/owner/brain/git/ref/heads/main" })
    .reply(200, { object: { sha: BASE_SHA } })
    .times(flush ? 2 : 1);
  gh.intercept({ method: "GET", path: `/repos/owner/brain/tarball/${BASE_SHA}` }).reply(200, tar);

  if (flush) {
    gh.intercept({ method: "GET", path: `/repos/owner/brain/git/commits/${BASE_SHA}` }).reply(200, {
      tree: { sha: "tree-base" },
    });
    gh.intercept({ method: "POST", path: "/repos/owner/brain/git/trees" }).reply(200, (req) => {
      script.trees.push(JSON.parse(req.body as string));
      return { sha: "tree-new" };
    });
    gh.intercept({ method: "POST", path: "/repos/owner/brain/git/commits" }).reply(200, (req) => {
      script.commits.push(JSON.parse(req.body as string));
      return { sha: NEW_SHA };
    });
    gh.intercept({ method: "PATCH", path: "/repos/owner/brain/git/refs/heads/main" }).reply(200, (req) => {
      script.patches.push(JSON.parse(req.body as string));
      return { object: { sha: NEW_SHA } };
    });
  }
  return script;
}

/** GitHub that fails at the first call — a beat dies at its earliest stage. */
export function mockGitHubDown(): void {
  fetchMock
    .get("https://api.github.com")
    .intercept({ method: "GET", path: "/repos/owner/brain/git/ref/heads/main" })
    .reply(500, "github down");
}

export interface KimiScript {
  requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }>;
}

/** Script one Kimi completion (MOONSHOT_BASE_URL → https://fake-kimi.test/v1). */
export function mockKimi(reportBody = "# Daily brief\n\nAll quiet on the test front."): KimiScript {
  const script: KimiScript = { requests: [] };
  fetchMock
    .get("https://fake-kimi.test")
    .intercept({ method: "POST", path: "/v1/chat/completions" })
    .reply(200, (req) => {
      script.requests.push(JSON.parse(req.body as string));
      return {
        choices: [{ message: { content: reportBody } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
    });
  return script;
}

export interface DiscordScript {
  dmOpens: Array<{ recipient_id: string }>;
  messages: Array<{ content: string }>;
}

/** Script one Discord bot-DM delivery: open DM channel → post message. */
export function mockDiscord(): DiscordScript {
  const script: DiscordScript = { dmOpens: [], messages: [] };
  const discord = fetchMock.get("https://discord.com");
  discord.intercept({ method: "POST", path: "/api/v10/users/@me/channels" }).reply(200, (req) => {
    script.dmOpens.push(JSON.parse(req.body as string));
    return { id: "dm-channel-1" };
  });
  discord.intercept({ method: "POST", path: "/api/v10/channels/dm-channel-1/messages" }).reply(200, (req) => {
    script.messages.push(JSON.parse(req.body as string));
    return { id: "msg-1" };
  });
  return script;
}
