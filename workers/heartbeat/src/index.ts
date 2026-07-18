import { GitHubInstanceStore } from "../../../src/instance/store-github.js";
import { githubToken } from "../../../src/instance/github-auth.js";
import { buildAgentCardFromBundle } from "../../../src/a2a/card-core.js";
import { listCabinet, msGraphConfigured } from "../../../src/sources/msgraph.js";
import { listDocs, githubDocsConfigured } from "../../../src/sources/github-docs.js";
import { envRecord, type Env } from "./env.js";
import { HeartbeatDO } from "./heartbeat-do.js";
import { DirectionDO } from "./direction-do.js";
import { handleInteraction } from "./interactions.js";

export { HeartbeatDO, DirectionDO };

/**
 * Constant-time bearer check (`crypto.subtle.timingSafeEqual`, a Workers
 * API): a plain `!==` short-circuits at the first differing byte — a timing
 * side-channel. Length mismatch returns early, which leaks only length.
 */
function bearerOk(header: string | null, expected: string | undefined): boolean {
  if (!expected) return false;
  const enc = new TextEncoder();
  const a = enc.encode(header ?? "");
  const b = enc.encode(`Bearer ${expected}`);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * The heartbeat Worker: a handful of routes (two of them bearer-gated),
 * everything else 404. All A2A
 * surfaces are short-connection by decision (streaming: false) — never add
 * an SSE endpoint here; on Durable Objects idle SSE time is billed wall
 * clock with no hibernation.
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const stub = env.HEARTBEAT_DO.get(env.HEARTBEAT_DO.idFromName("main"));

    // First-arm bootstrapping: any request ensures the alarms exist
    // (alarms survive deploys; both calls are idempotent).
    if (url.pathname !== "/ensure-alarm") {
      await stub.fetch("https://do/ensure-alarm");
      if (Number(env.DIRECTION_GMAIL_POLL_MINUTES ?? 0) > 0) {
        await env.DIRECTION_DO.get(env.DIRECTION_DO.idFromName("main")).fetch("https://do/ensure-poll", {
          method: "POST",
        });
      }
    }

    if (url.pathname === "/healthz" && req.method === "GET") {
      // No auth: summary counts only, no secrets.
      return stub.fetch("https://do/status");
    }

    if (url.pathname === "/interactions" && req.method === "POST") {
      // Inbound direction (Discord webhook). Absent public key = surface off.
      if (!env.DISCORD_PUBLIC_KEY) return new Response("not found", { status: 404 });
      return handleInteraction(req, env);
    }

    if (url.pathname === "/beat" && req.method === "POST") {
      if (!bearerOk(req.headers.get("authorization"), env.BEAT_TRIGGER_TOKEN)) {
        return new Response("unauthorized", { status: 401 });
      }
      return stub.fetch("https://do/trigger", { method: "POST" });
    }

    if (url.pathname === "/graph/check" && req.method === "GET") {
      // Operator validation for the 'onedrive' source: same bearer gate as
      // /beat (listing names is instance data — never expose unauthenticated).
      if (!bearerOk(req.headers.get("authorization"), env.BEAT_TRIGGER_TOKEN)) {
        return new Response("unauthorized", { status: 401 });
      }
      const ctx = { env: envRecord(env) };
      if (!msGraphConfigured(ctx)) {
        return Response.json({ ok: false, error: "msgraph not configured (MSGRAPH_CLIENT_ID/MSGRAPH_REFRESH_TOKEN)" }, { status: 503 });
      }
      try {
        const listing = await listCabinet(ctx, { maxDepth: 1, maxEntries: 50 });
        return Response.json({
          ok: true,
          root: listing.root,
          count: listing.entries.length,
          truncated: listing.truncated,
          entries: listing.entries.map((e) => ({ name: e.name, folder: e.isFolder, modified: e.lastModified?.slice(0, 10) })),
        });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 502 });
      }
    }

    if (url.pathname === "/docs/check" && req.method === "GET") {
      // Operator validation for the 'github-docs' source: same bearer gate as
      // /beat (listing paths is instance data — never expose unauthenticated).
      if (!bearerOk(req.headers.get("authorization"), env.BEAT_TRIGGER_TOKEN)) {
        return new Response("unauthorized", { status: 401 });
      }
      const ctx = { env: envRecord(env) };
      if (!githubDocsConfigured(ctx)) {
        return Response.json({ ok: false, error: "github-docs not configured (GITHUB_DOCS_REPO)" }, { status: 503 });
      }
      try {
        const listing = await listDocs(ctx, { maxEntries: 50 });
        return Response.json({
          ok: true,
          origin: listing.origin,
          count: listing.entries.length,
          truncated: listing.truncated,
          entries: listing.entries.map((e) => e.path),
        });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 502 });
      }
    }

    if (url.pathname === "/.well-known/agent-card.json" && req.method === "GET") {
      const store = new GitHubInstanceStore({
        repo: env.BRAIN_REPO,
        ref: env.BRAIN_REF,
        token: await githubToken(envRecord(env)),
      });
      const card = buildAgentCardFromBundle(await store.loadBundle(), await store.loadConfig());
      if (card.url.startsWith("urn:")) {
        card.url = `${url.origin}/.well-known/agent-card.json`;
      }
      return Response.json(card, { headers: { "Cache-Control": "public, max-age=3600" } });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
