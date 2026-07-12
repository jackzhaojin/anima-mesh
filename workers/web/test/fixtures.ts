import { fetchMock } from "cloudflare:test";

/**
 * Workerd-safe fixtures for the web tier: a raw tar of a minimal brain (the
 * store's gunzip passes non-gzip bytes through), scripted GitHub reads, a
 * scripted heartbeat Worker, and a scripted Google token endpoint. Same
 * one-shot exact-count interceptor discipline as workers/heartbeat/test.
 */

// ---- raw tar builder (mirrors workers/heartbeat/test — separate package) -----

function tarEntry(name: string, content: string): Uint8Array {
  const data = new TextEncoder().encode(content);
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name), 0);
  header.set(enc.encode("0000644\0"), 100);
  header.set(enc.encode("0000000\0"), 108);
  header.set(enc.encode("0000000\0"), 116);
  header.set(enc.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124);
  header.set(enc.encode("00000000000\0"), 136);
  header.set(enc.encode("        "), 148);
  header[156] = 0x30;
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

function buildTar(files: Record<string, string>, topDir = "owner-brain-abc1234"): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [rel, content] of Object.entries(files)) parts.push(tarEntry(`${topDir}/${rel}`, content));
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const BASE_SHA = "a".repeat(40);

function concept(type: string, extra: Record<string, unknown>, body: string): string {
  const fm = [`type: ${type}`];
  for (const [k, v] of Object.entries(extra)) fm.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return `---\n${fm.join("\n")}\n---\n\n${body}\n`;
}

export function brainFiles(): Record<string, string> {
  return {
    "animamesh.config.json": JSON.stringify({ bundle: "bundle" }),
    "bundle/index.md": concept("index", { title: "Test Mesh" }, "# Index\n"),
    "bundle/log.md": concept("log", {}, "# Log\n"),
    "bundle/constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
    "ledger/actions.jsonl":
      [
        { ts: "2026-07-10T12:00:00Z", runId: "run-aaaa", agent: "chief-of-staff", action: "run-completed", type: "report" },
        { ts: "2026-07-11T09:00:00Z", runId: "run-bbbb", agent: "chief-of-staff", action: "direction-completed", type: "report" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    "reports/2026-07-10-chief-of-staff-run0aaaa.md":
      "---\ntype: report\n---\n\n# The daily brief\n\nAll quiet; runway is fine.\n",
    "reports/2026-07-11-chief-of-staff.direction-run0bbbb.md":
      "---\ntype: report\ntrigger: direction\n---\n\n## Direction received\n\nsecret question\n\n## Disposition\n\nanswered\n",
    // "README.md" sorts AFTER every date-stamped name — the live 2026-07-12
    // bug where it stole the "Latest brief" panel. Tests must keep it here.
    "reports/README.md": "# reports/ directory docs — NOT a brief\n",
    // A NEWER spoke report that sorts after the hub's: the panel must still
    // show the hub's brief (second live 2026-07-12 lesson — same-day names
    // sort by agent alphabetically, and the spoke stole the panel).
    "reports/2026-07-11-research-watch-run0dddd.md":
      "---\ntype: report\n---\n\n# Spoke findings\n\nspoke noise, not the brief\n",
    "approvals/appr-1.json": JSON.stringify({
      id: "appr-1",
      actionType: "government-filing",
      summary: "file the annual return",
      requestedBy: "bookkeeper",
      requestedAt: "2026-07-10T09:00:00Z",
      status: "pending",
    }),
  };
}

// ---- scripted services --------------------------------------------------------

/** GitHub reads for one dashboard render: ref + tarball + commits list. */
export function mockGitHubReads(files: Record<string, string> = brainFiles()): void {
  const gh = fetchMock.get("https://api.github.com");
  gh.intercept({ method: "GET", path: "/repos/owner/brain/git/ref/heads/main" }).reply(200, {
    object: { sha: BASE_SHA },
  });
  gh.intercept({ method: "GET", path: `/repos/owner/brain/tarball/${BASE_SHA}` }).reply(200, buildTar(files));
  gh.intercept({ method: "GET", path: (p) => p.startsWith("/repos/owner/brain/commits?") }).reply(200, [
    { sha: "c".repeat(40), commit: { message: "beat(cloud): 2026-07-11 — 1 run(s)", author: { date: "2026-07-11T12:00:05Z" } } },
  ]);
}

/** The heartbeat Worker's /healthz for one render. */
export function mockHealthz(): void {
  fetchMock
    .get("https://heartbeat.test")
    .intercept({ method: "GET", path: "/healthz" })
    .reply(200, {
      lastBeat: { at: "2026-07-11T12:00:01Z", kind: "alarm", ok: true, date: "2026-07-11", due: 1, ran: 1, skipped: 3, failureCount: 0, delivered: true, commitSha: "c".repeat(40) },
      nextAlarm: "2026-07-12T12:00:00.000Z",
    });
}

/** One beat-trigger proxy call; captures the Authorization header. */
export function mockBeatTrigger(): { auth: string[] } {
  const captured = { auth: [] as string[] };
  fetchMock
    .get("https://heartbeat.test")
    .intercept({ method: "POST", path: "/beat" })
    .reply(202, (req) => {
      const headers = req.headers as Record<string, string> | Headers;
      const get = (k: string) =>
        headers instanceof Headers ? (headers.get(k) ?? "") : (headers[k] ?? headers[k.toLowerCase()] ?? "");
      captured.auth.push(get("authorization"));
      return { kind: "manual", summary: { due: 0, ran: 0, skipped: 4, failures: [] } };
    });
  return captured;
}

// ---- Google -------------------------------------------------------------------

const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** An id_token as Google's token endpoint would mint it (signature unchecked
 * by design — it arrives first-hand over TLS; see src/auth.ts). */
export function idToken(claims: Record<string, unknown>): string {
  const base = {
    iss: "https://accounts.google.com",
    aud: "test-client-id.apps.googleusercontent.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    email_verified: true,
    ...claims,
  };
  return `${b64url(JSON.stringify({ alg: "RS256" }))}.${b64url(JSON.stringify(base))}.fakesig`;
}

/** Script one code-for-token exchange returning the given id_token. */
export function mockGoogleToken(token: string): { bodies: string[] } {
  const captured = { bodies: [] as string[] };
  fetchMock
    .get("https://oauth2.googleapis.com")
    .intercept({ method: "POST", path: "/token" })
    .reply(200, (req) => {
      captured.bodies.push(req.body as string);
      return { id_token: token };
    });
  return captured;
}
