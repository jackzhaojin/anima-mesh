import type { SourceContext } from "./types.js";
import { getEnv } from "../instance/env-core.js";

/**
 * Microsoft Graph / OneDrive, read-only, via OAuth refresh token — the
 * instance's filing cabinet. Pure fetch + Web platform (this module runs on
 * Workers: the beat inlines a cabinet listing into agent prompts).
 *
 * Env contract (names only; values live in Worker secrets / instance .env):
 * - MSGRAPH_CLIENT_ID      required — the app registration's client id
 * - MSGRAPH_REFRESH_TOKEN  required — delegated consent, read scopes only
 * - MSGRAPH_CLIENT_SECRET  optional — absent for public clients (device-code
 *                          consent needs no secret; the refresh grant then
 *                          authenticates by client_id alone)
 * - MSGRAPH_TENANT         optional — Entra tenant id/domain; default "common"
 * - MSGRAPH_DRIVE_ID       optional — a specific drive (e.g. a SharePoint
 *                          library); default the consenting user's OneDrive
 * - MSGRAPH_CABINET_PATH   optional — folder path under the drive root that
 *                          IS the cabinet; default the drive root
 * - MSGRAPH_SCOPE          optional — default "Files.Read.All offline_access"
 *                          (read-only superset that can follow shortcuts into
 *                          shared libraries; never request a write scope)
 *
 * Refresh tokens rotate on use but the prior token stays valid until its own
 * expiry, so a static secret works; if Graph starts returning invalid_grant,
 * re-run the instance's consent helper and rotate the secret.
 */

const LOGIN_BASE = "https://login.microsoftonline.com";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const DEFAULT_SCOPE = "https://graph.microsoft.com/Files.Read.All offline_access";
const PAGE_SIZE = 200;
const SELECT = "id,name,size,folder,file,lastModifiedDateTime,remoteItem";

export function assertMsGraphConfigured(ctx: SourceContext): void {
  for (const key of ["MSGRAPH_CLIENT_ID", "MSGRAPH_REFRESH_TOKEN"]) {
    if (!getEnv(ctx.env, key)) throw new Error(`msgraph source: ${key} is not set`);
  }
}

export function msGraphConfigured(ctx: SourceContext): boolean {
  return Boolean(getEnv(ctx.env, "MSGRAPH_CLIENT_ID") && getEnv(ctx.env, "MSGRAPH_REFRESH_TOKEN"));
}

export async function msGraphAccessToken(ctx: SourceContext): Promise<string> {
  assertMsGraphConfigured(ctx);
  const doFetch = ctx.fetchImpl ?? fetch;
  const tenant = getEnv(ctx.env, "MSGRAPH_TENANT") || "common";
  const params: Record<string, string> = {
    client_id: getEnv(ctx.env, "MSGRAPH_CLIENT_ID")!,
    refresh_token: getEnv(ctx.env, "MSGRAPH_REFRESH_TOKEN")!,
    grant_type: "refresh_token",
    scope: getEnv(ctx.env, "MSGRAPH_SCOPE") || DEFAULT_SCOPE,
  };
  const secret = getEnv(ctx.env, "MSGRAPH_CLIENT_SECRET");
  if (secret) params.client_secret = secret;

  const res = await doFetch(`${LOGIN_BASE}/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    // Entra error bodies carry an error code worth surfacing (e.g.
    // invalid_grant = consent expired → re-run the consent helper).
    throw new Error(`msgraph token refresh → HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

export interface CabinetEntry {
  /** Cabinet-relative path, e.g. "Finance/Receipts/2025-10-01.pdf". */
  path: string;
  name: string;
  isFolder: boolean;
  size?: number;
  lastModified?: string;
  /** Graph coordinates — what readCabinetFile needs. */
  driveId: string;
  itemId: string;
}

export interface CabinetListing {
  entries: CabinetEntry[];
  /** True when maxEntries/maxDepth cut the walk short — never silently. */
  truncated: boolean;
  root: string;
}

interface GraphItem {
  id: string;
  name: string;
  size?: number;
  folder?: { childCount?: number };
  file?: object;
  lastModifiedDateTime?: string;
  remoteItem?: { id: string; parentReference?: { driveId?: string } };
}

function driveBase(ctx: SourceContext): string {
  const driveId = getEnv(ctx.env, "MSGRAPH_DRIVE_ID");
  return driveId ? `${GRAPH_BASE}/drives/${driveId}` : `${GRAPH_BASE}/me/drive`;
}

async function graphJson<T>(ctx: SourceContext, token: string, url: string): Promise<T> {
  const doFetch = ctx.fetchImpl ?? fetch;
  const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`msgraph GET ${new URL(url).pathname} → HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  return (await res.json()) as T;
}

/** Resolve the cabinet root folder to (driveId, itemId), following a shortcut if the root itself is one. */
async function resolveRoot(ctx: SourceContext, token: string): Promise<{ driveId: string; itemId: string; label: string }> {
  const path = (getEnv(ctx.env, "MSGRAPH_CABINET_PATH") ?? "").replace(/^\/+|\/+$/g, "");
  const url = path
    ? `${driveBase(ctx)}/root:/${encodeURIComponent(path).replace(/%2F/gi, "/")}`
    : `${driveBase(ctx)}/root`;
  const item = await graphJson<GraphItem & { parentReference?: { driveId?: string } }>(ctx, token, `${url}?$select=${SELECT},parentReference`);
  // A Teams/SharePoint channel folder added to OneDrive is a shortcut
  // (remoteItem): the real children live in the remote drive.
  if (item.remoteItem?.parentReference?.driveId) {
    return { driveId: item.remoteItem.parentReference.driveId, itemId: item.remoteItem.id, label: path || "(drive root)" };
  }
  const driveId = getEnv(ctx.env, "MSGRAPH_DRIVE_ID") ?? item.parentReference?.driveId ?? "me";
  return { driveId, itemId: item.id, label: path || "(drive root)" };
}

/**
 * Bounded breadth-first listing of the cabinet — folders and files with
 * sizes and modified dates, shortcuts followed into their remote drives.
 * Read-only by construction: nothing here issues anything but GETs.
 */
export async function listCabinet(
  ctx: SourceContext,
  opts: { maxEntries?: number; maxDepth?: number } = {},
): Promise<CabinetListing> {
  const maxEntries = opts.maxEntries ?? 300;
  const maxDepth = opts.maxDepth ?? 4;
  const token = await msGraphAccessToken(ctx);
  const root = await resolveRoot(ctx, token);

  const entries: CabinetEntry[] = [];
  let truncated = false;
  const queue: Array<{ driveId: string; itemId: string; prefix: string; depth: number }> = [
    { driveId: root.driveId, itemId: root.itemId, prefix: "", depth: 0 },
  ];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    const base = dir.driveId === "me" ? `${GRAPH_BASE}/me/drive` : `${GRAPH_BASE}/drives/${dir.driveId}`;
    let url: string | undefined = `${base}/items/${dir.itemId}/children?$select=${SELECT}&$top=${PAGE_SIZE}`;

    while (url) {
      const page: { value: GraphItem[]; "@odata.nextLink"?: string } = await graphJson(ctx, token, url);
      for (const item of page.value) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return { entries, truncated, root: root.label };
        }
        const isFolder = Boolean(item.folder) || Boolean(item.remoteItem);
        const childDriveId = item.remoteItem?.parentReference?.driveId ?? dir.driveId;
        const childItemId = item.remoteItem?.id ?? item.id;
        const path = dir.prefix ? `${dir.prefix}/${item.name}` : item.name;
        entries.push({
          path,
          name: item.name,
          isFolder,
          size: item.size,
          lastModified: item.lastModifiedDateTime,
          driveId: childDriveId,
          itemId: childItemId,
        });
        if (isFolder) {
          if (dir.depth + 1 < maxDepth) {
            queue.push({ driveId: childDriveId, itemId: childItemId, prefix: path, depth: dir.depth + 1 });
          } else {
            truncated = true; // there is a level below that the walk won't visit
          }
        }
      }
      url = page["@odata.nextLink"];
    }
  }
  return { entries, truncated, root: root.label };
}

const TEXT_EXTENSIONS = /\.(md|txt|csv|tsv|json|ya?ml|xml|html?|log)$/i;

/**
 * Content of one text-like cabinet file, clipped. Binary formats are
 * refused by extension — extraction pipelines belong to the instance, not
 * a prompt-assembly source.
 */
export async function readCabinetFile(
  ctx: SourceContext,
  entry: Pick<CabinetEntry, "driveId" | "itemId" | "name">,
  opts: { maxChars?: number } = {},
): Promise<string> {
  if (!TEXT_EXTENSIONS.test(entry.name)) {
    throw new Error(`msgraph source: '${entry.name}' is not a text format this source will inline`);
  }
  const maxChars = opts.maxChars ?? 20_000;
  const token = await msGraphAccessToken(ctx);
  const doFetch = ctx.fetchImpl ?? fetch;
  const base = entry.driveId === "me" ? `${GRAPH_BASE}/me/drive` : `${GRAPH_BASE}/drives/${entry.driveId}`;
  // /content 302s to a pre-authenticated download URL; fetch follows it.
  const res = await doFetch(`${base}/items/${entry.itemId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`msgraph content → HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  const text = await res.text();
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text;
}

const LISTING_CHAR_BUDGET = 12_000;

/** The listing as compact markdown for prompt injection — one line per entry. */
export function cabinetListingMarkdown(listing: CabinetListing): string {
  const lines: string[] = [];
  for (const e of listing.entries) {
    const depth = e.path.split("/").length - 1;
    const meta = e.isFolder
      ? "folder"
      : [e.size !== undefined ? formatSize(e.size) : null, e.lastModified?.slice(0, 10)].filter(Boolean).join(", ");
    lines.push(`${"  ".repeat(depth)}- ${e.name}${e.isFolder ? "/" : ""}${meta ? ` (${meta})` : ""}`);
  }
  let body = lines.join("\n");
  let clipped = false;
  if (body.length > LISTING_CHAR_BUDGET) {
    body = body.slice(0, LISTING_CHAR_BUDGET);
    body = body.slice(0, body.lastIndexOf("\n"));
    clipped = true;
  }
  const notes = [
    `${listing.entries.length} entries under ${listing.root}`,
    listing.truncated || clipped ? "listing bounded — deeper/further content exists" : null,
  ].filter(Boolean);
  return `${body}\n\n_(${notes.join("; ")})_`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
