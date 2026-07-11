import type { Env } from "./env.js";
import { loginRedirect, handleCallback, sessionEmail, logout } from "./auth.js";
import { gatherDashboard, dashboardPage, loginPage, forbiddenPage, beatResultPage } from "./dashboard.js";

/**
 * animamesh-web — the mesh's face: one human (the allowlisted principal),
 * one dashboard, one action. Separate Worker by decision Q1b so the
 * heartbeat stays untouched and this tier holds only read + trigger
 * secrets. Everything session-gated except the login flow; deny-by-default.
 * No SSE, no WebSockets, no client JS — request/response only (B2/D7).
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const title = env.DASHBOARD_TITLE ?? "AnimaMesh";

    if (url.pathname === "/auth/login" && req.method === "GET") {
      return loginRedirect(env, url.origin);
    }

    if (url.pathname === "/auth/callback" && req.method === "GET") {
      const result = await handleCallback(req, env, url.origin);
      if (result.ok) return result.response;
      return result.status === 403
        ? forbiddenPage(title)
        : new Response(`login failed: ${result.reason}`, { status: result.status });
    }

    if (url.pathname === "/logout") {
      return logout();
    }

    const email = await sessionEmail(req, env);

    if (url.pathname === "/" && req.method === "GET") {
      if (!email) return loginPage(title);
      return dashboardPage(env, email, await gatherDashboard(env));
    }

    if (url.pathname === "/actions/beat" && req.method === "POST") {
      if (!email) return new Response("unauthorized", { status: 401 });
      // CSRF posture: SameSite=Lax cookies + a same-origin check on POSTs.
      const origin = req.headers.get("origin");
      if (origin !== url.origin) return new Response("forbidden", { status: 403 });
      const beat = await fetch(`${env.HEARTBEAT_URL}/beat`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.BEAT_TRIGGER_TOKEN}` }, // never leaves the server
      });
      return beatResultPage(title, await beat.text());
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
