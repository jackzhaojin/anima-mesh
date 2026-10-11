// Workers-egress probe for the `openai-codex` harness: does chatgpt.com's
// Codex endpoint (and the auth.openai.com token host) answer a Cloudflare
// Worker? Run with `wrangler dev --remote` so the fetch leaves Cloudflare's
// real edge. Uses a READ-ONLY access token (no refresh is ever sent), so it
// cannot rotate or spend anyone's login.

const CODEX = "https://chatgpt.com/backend-api/codex/responses";
const TOKEN_HOST = "https://auth.openai.com/oauth/token";

async function codex(env, { web }) {
  const res = await fetch(CODEX, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CODEX_ACCESS_TOKEN}`,
      "chatgpt-account-id": env.CODEX_ACCOUNT_ID,
      "openai-beta": "responses=experimental",
      originator: "anima-mesh",
      session_id: crypto.randomUUID(),
      accept: "text/event-stream",
      "content-type": "application/json",
      ...(env.PROBE_UA ? { "user-agent": env.PROBE_UA } : {}),
    },
    body: JSON.stringify({
      model: env.CODEX_MODEL || "gpt-5.5",
      instructions: "Answer briefly.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: web
        ? "Search the web for today's date and state it in ISO form."
        : "Reply with exactly: Workers egress OK" }] }],
      tools: web ? [{ type: "web_search" }] : [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      stream: true,
    }),
  });
  const body = await res.text();
  let text = "", searches = 0;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const e = JSON.parse(line.slice(5));
      if (e.type === "response.output_text.delta") text += e.delta;
      if (e.type === "response.output_item.done" && e.item?.type === "web_search_call") searches++;
    } catch {}
  }
  return {
    status: res.status,
    cfMitigated: res.headers.get("cf-mitigated"),
    title: (body.match(/<title>([^<]*)/) || [])[1],
    edgeBlocked: body.trimStart().startsWith("<"),
    text: text.trim(),
    searches,
    ...(res.ok ? {} : { body: body.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400) }),
  };
}

async function tokenHost() {
  // An EMPTY grant: the token host must answer with a JSON OAuth error
  // (reachable) rather than an HTML challenge (blocked). Nothing is spent.
  const res = await fetch(TOKEN_HOST, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: "grant_type=refresh_token",
  });
  const body = await res.text();
  return { status: res.status, edgeBlocked: body.trimStart().startsWith("<"), body: body.slice(0, 160) };
}

async function openaiApiHost() {
  // No credential at all: a JSON 401 means the METERED API host answers
  // Workers (only the subscription host is in question); HTML means blocked.
  const res = await fetch("https://api.openai.com/v1/models");
  const body = await res.text();
  return { status: res.status, edgeBlocked: body.trimStart().startsWith("<"), body: body.slice(0, 120) };
}

export default {
  async fetch(_req, envIn) {
    // ?ua=1 retries with a User-Agent: Workers send none by default, and some
    // edges 403 a UA-less request (docs/learnings/2026-07-18-github-ua-less-403.md).
    const ua = new URL(_req.url).searchParams.get("ua");
    const env = { ...envIn, ...(ua ? { PROBE_UA: ua === "1" ? "anima-mesh/2.0 (+https://github.com/jackzhaojin/anima-mesh)" : ua } : {}) };
    const [plain, web, token, api] = await Promise.all([
      codex(env, { web: false }),
      codex(env, { web: true }),
      tokenHost(),
      openaiApiHost(),
    ]);
    return Response.json({ colo: _req.cf?.colo, plain, web, tokenHost: token, openaiApiHost: api }, { headers: { "cache-control": "no-store" } });
  },
};
