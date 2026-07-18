import { GitHubInstanceStore } from "../../../src/instance/store-github.js";
import { githubToken } from "../../../src/instance/github-auth.js";
import type { Env } from "./env.js";

/**
 * The dashboard (decision Q2: view + trigger-beat) — server-rendered HTML,
 * zero client JS, no SSE/WebSockets (B2). Reads the SAME brain the beats
 * write through the same store seam; the repo stays the only state (B1).
 */

interface Healthz {
  lastBeat: {
    at: string;
    kind: string;
    ok: boolean;
    date?: string;
    due?: number;
    ran?: number;
    skipped?: number;
    failureCount?: number;
    delivered?: boolean;
    commitSha?: string;
  } | null;
  nextAlarm: string | null;
}

export interface DashboardData {
  healthz: Healthz | null;
  latestBriefName: string | null;
  latestBrief: string | null;
  reports: string[];
  ledgerTail: Array<{ ts: string; agent: string; action: string; runId: string }>;
  approvals: Array<{ id: string; actionType: string; summary: string; status: string }>;
  commits: Array<{ sha: string; message: string; date: string }>;
}

export async function gatherDashboard(env: Env): Promise<DashboardData> {
  const token = await githubToken({
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_INSTALLATION_ID: env.GITHUB_APP_INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_TOKEN: env.GITHUB_TOKEN,
  });
  const store = new GitHubInstanceStore({
    repo: env.BRAIN_REPO,
    ref: env.BRAIN_REF,
    token,
  });

  const [healthz, reports, ledger, approvals, commits] = await Promise.all([
    fetch(`${env.HEARTBEAT_URL}/healthz`)
      .then((r) => (r.ok ? (r.json() as Promise<Healthz>) : null))
      .catch(() => null),
    store.listReports(),
    store.readLedger(),
    store.listApprovals(),
    fetch(`https://api.github.com/repos/${env.BRAIN_REPO}/commits?sha=${env.BRAIN_REF}&per_page=10`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "animamesh-web",
      },
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((list) =>
        (list as Array<{ sha: string; commit: { message: string; author?: { date?: string } } }>).map((c) => ({
          sha: c.sha.slice(0, 8),
          message: c.commit.message.split("\n")[0]!,
          date: c.commit.author?.date ?? "",
        })),
      )
      .catch(() => []),
  ]);

  // "The brief" is the HUB's newest report (direction artifacts use the
  // dot-name precisely so they never masquerade as briefs). Only
  // date-stamped run artifacts qualify — reports/ also holds a README.md,
  // which sorts after every "2026-…" name and stole the panel (found live
  // on first dashboard login, 2026-07-12). Within a day, names sort by
  // agent alphabetically, so prefer the configured hub agent (the delivery
  // matcher's `-{agent}-` convention) and fall back to any dated report.
  const config = await store.loadConfig().catch(() => null);
  const hub = config?.direction?.agent ?? config?.delivery?.deliverAgent ?? "chief-of-staff";
  const dated = reports.filter((r) => /^\d{4}-\d{2}-\d{2}-/.test(r) && !r.includes(".direction-"));
  const hubReports = dated.filter((r) => r.includes(`-${hub}-`));
  const briefs = hubReports.length > 0 ? hubReports : dated;
  const latestBriefName = briefs[briefs.length - 1] ?? null;
  const latestBrief = latestBriefName ? await store.readReport(latestBriefName).catch(() => null) : null;

  return {
    healthz,
    latestBriefName,
    latestBrief,
    reports: reports.slice(-12).reverse(),
    ledgerTail: ledger.slice(-15).reverse() as DashboardData["ledgerTail"],
    approvals: approvals.filter((a) => a.status === "pending"),
    commits,
  };
}

// ---- rendering ----------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CSS = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 60rem; padding: 1.5rem; line-height: 1.45; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 1.8rem; }
  .ok { color: #1a7f37; } .bad { color: #cf222e; }
  .muted { opacity: .65; font-size: .85rem; }
  pre { background: rgba(127,127,127,.1); padding: .8rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  td, th { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid rgba(127,127,127,.25); }
  form { display: inline; }
  button { padding: .4rem .9rem; border-radius: 6px; border: 1px solid rgba(127,127,127,.4); cursor: pointer; }
  header { display: flex; justify-content: space-between; align-items: baseline; }
`;

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export function loginPage(title: string): Response {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><p>This is a private operations surface.</p><p><a href="/auth/login">Sign in with Google</a></p>`,
  );
}

export function forbiddenPage(title: string): Response {
  const res = page(title, `<h1>${escapeHtml(title)}</h1><p>403 — this account is not authorized.</p>`);
  return new Response(res.body, { status: 403, headers: res.headers });
}

export function beatResultPage(title: string, summary: string): Response {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><h2>Beat triggered</h2><pre>${escapeHtml(summary)}</pre><p><a href="/">← back to the dashboard</a></p>`,
  );
}

export function dashboardPage(env: Env, email: string, d: DashboardData): Response {
  const title = env.DASHBOARD_TITLE ?? "AnimaMesh";
  const lb = d.healthz?.lastBeat;
  const beat = lb
    ? `<p>Last beat <strong class="${lb.ok ? "ok" : "bad"}">${lb.ok ? "OK" : "FAILED"}</strong>
       (${escapeHtml(lb.kind)} · ${escapeHtml(lb.at)}) — due ${lb.due ?? "?"}, ran ${lb.ran ?? "?"},
       skipped ${lb.skipped ?? "?"}, failures ${lb.failureCount ?? "?"}
       ${lb.commitSha ? ` · commit <code>${escapeHtml(lb.commitSha.slice(0, 8))}</code>` : ""}</p>`
    : `<p class="muted">No beat recorded yet.</p>`;
  const nextAlarm = d.healthz?.nextAlarm
    ? `<p class="muted">Next alarm: ${escapeHtml(d.healthz.nextAlarm)}</p>`
    : "";

  const brief = d.latestBrief
    ? `<h2>Latest brief <span class="muted">${escapeHtml(d.latestBriefName ?? "")}</span></h2><pre>${escapeHtml(d.latestBrief)}</pre>`
    : `<h2>Latest brief</h2><p class="muted">none yet</p>`;

  const approvals = d.approvals.length
    ? `<ul>${d.approvals.map((a) => `<li><code>${escapeHtml(a.id)}</code> — ${escapeHtml(a.actionType)}: ${escapeHtml(a.summary)}</li>`).join("")}</ul>`
    : `<p class="muted">nothing pending</p>`;

  const ledger = d.ledgerTail
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.ts)}</td><td>${escapeHtml(e.agent)}</td><td>${escapeHtml(e.action)}</td><td class="muted">${escapeHtml(e.runId.slice(0, 8))}</td></tr>`,
    )
    .join("");

  const commits = d.commits
    .map((c) => `<tr><td><code>${escapeHtml(c.sha)}</code></td><td>${escapeHtml(c.message)}</td><td class="muted">${escapeHtml(c.date)}</td></tr>`)
    .join("");

  const reports = d.reports.map((r) => `<li><code>${escapeHtml(r)}</code></li>`).join("");

  return page(
    title,
    `<header><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(email)} · <a href="/logout">sign out</a></p></header>
     <h2>Heartbeat</h2>${beat}${nextAlarm}
     <form method="post" action="/actions/beat"><button>Trigger a beat now</button></form>
     ${brief}
     <h2>Pending approvals</h2>${approvals}
     <h2>Ledger tail</h2><table><tr><th>ts</th><th>agent</th><th>action</th><th>run</th></tr>${ledger}</table>
     <h2>Recent commits</h2><table>${commits}</table>
     <h2>Recent reports</h2><ul>${reports}</ul>`,
  );
}
