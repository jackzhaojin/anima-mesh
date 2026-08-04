import { describe, it, expect, vi } from "vitest";
import {
  assertMsGraphConfigured,
  msGraphAccessToken,
  listCabinet,
  readCabinetFile,
  readCabinetPath,
  extractPdfText,
  cabinetListingMarkdown,
  selectFilesToInline,
  inlineCabinetFiles,
  cabinetContentsMarkdown,
  type CabinetListing,
} from "../src/sources/msgraph.js";
import { sourceSections } from "../src/sources/registry.js";

/**
 * The 'onedrive' read source against a scripted Graph API: refresh grant
 * shape (secret optional — device-code public clients have none), bounded
 * BFS listing with pagination and shortcut (remoteItem) traversal, text-only
 * content reads, and the honest-section failure posture.
 */

const ENV = {
  MSGRAPH_CLIENT_ID: "client-1",
  MSGRAPH_REFRESH_TOKEN: "rt-1",
  MSGRAPH_CABINET_PATH: "Cabinet",
};

type Handler = (url: string, init?: RequestInit) => Response;

function graphFetch(overrides: Record<string, Handler> = {}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    for (const [needle, handler] of Object.entries(overrides)) {
      if (url.includes(needle)) return handler(url, init);
    }
    if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "at-1" });
    if (url.includes("/me/drive/root:/Cabinet?")) {
      return Response.json({ id: "root-1", name: "Cabinet", folder: {}, parentReference: { driveId: "d-me" } });
    }
    if (url.includes("/drives/d-me/items/root-1/children")) {
      return Response.json({
        value: [
          { id: "f-fin", name: "Finance", folder: { childCount: 2 } },
          {
            id: "sc-1",
            name: "Shared",
            remoteItem: { id: "r-1", parentReference: { driveId: "d-remote" } },
          },
          { id: "doc-1", name: "notes.md", file: {}, size: 2048, lastModifiedDateTime: "2026-07-01T08:00:00Z" },
        ],
      });
    }
    if (url.includes("/drives/d-me/items/f-fin/children")) {
      return Response.json({
        value: [{ id: "csv-1", name: "chase.csv", file: {}, size: 512, lastModifiedDateTime: "2026-07-15T12:00:00Z" }],
      });
    }
    if (url.includes("/drives/d-remote/items/r-1/children")) {
      return Response.json({ value: [{ id: "leg-1", name: "resolution.pdf", file: {}, size: 9999 }] });
    }
    if (url.includes("/items/csv-1/content")) return new Response("date,amount\n2026-07-01,42.00");
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("msGraphAccessToken", () => {
  it("refresh grant carries client_id + refresh_token + read scope, NO secret for public clients", async () => {
    const mock = graphFetch();
    const token = await msGraphAccessToken({ env: ENV, fetchImpl: mock.fetchImpl });
    expect(token).toBe("at-1");
    const call = mock.calls.find((c) => c.url.includes("login.microsoftonline.com"))!;
    expect(call.url).toContain("/common/oauth2/v2.0/token");
    const body = new URLSearchParams(call.body!);
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("scope")).toContain("Files.Read.All");
    expect(body.get("client_secret")).toBeNull();
  });

  it("includes the secret and tenant when configured (confidential client)", async () => {
    const mock = graphFetch();
    await msGraphAccessToken({
      env: { ...ENV, MSGRAPH_CLIENT_SECRET: "s3cret", MSGRAPH_TENANT: "acme.example" },
      fetchImpl: mock.fetchImpl,
    });
    const call = mock.calls.find((c) => c.url.includes("login.microsoftonline.com"))!;
    expect(call.url).toContain("/acme.example/oauth2/v2.0/token");
    expect(new URLSearchParams(call.body!).get("client_secret")).toBe("s3cret");
  });

  it("names the missing env var when unconfigured", () => {
    expect(() => assertMsGraphConfigured({ env: { MSGRAPH_CLIENT_ID: "c" } })).toThrow(/MSGRAPH_REFRESH_TOKEN/);
  });
});

describe("listCabinet", () => {
  it("walks folders breadth-first, follows shortcuts into remote drives, records file metadata", async () => {
    const mock = graphFetch();
    const listing = await listCabinet({ env: ENV, fetchImpl: mock.fetchImpl });
    const paths = listing.entries.map((e) => e.path);
    expect(paths).toEqual(["Finance", "Shared", "notes.md", "Finance/chase.csv", "Shared/resolution.pdf"]);
    const chase = listing.entries.find((e) => e.path === "Finance/chase.csv")!;
    expect(chase).toMatchObject({ isFolder: false, size: 512, lastModified: "2026-07-15T12:00:00Z" });
    const shared = listing.entries.find((e) => e.path === "Shared/resolution.pdf")!;
    expect(shared.driveId).toBe("d-remote");
    expect(listing.truncated).toBe(false);
    // Read-only by construction: every Graph call was a GET.
    for (const c of mock.calls.filter((x) => x.url.includes("graph.microsoft.com"))) {
      expect(c.method).toBe("GET");
    }
  });

  it("stops at maxEntries and reports truncation instead of walking forever", async () => {
    const mock = graphFetch();
    const listing = await listCabinet({ env: ENV, fetchImpl: mock.fetchImpl }, { maxEntries: 2 });
    expect(listing.entries).toHaveLength(2);
    expect(listing.truncated).toBe(true);
  });

  it("marks truncated when maxDepth hides a level below", async () => {
    const mock = graphFetch();
    const listing = await listCabinet({ env: ENV, fetchImpl: mock.fetchImpl }, { maxDepth: 1 });
    expect(listing.entries.map((e) => e.path)).toEqual(["Finance", "Shared", "notes.md"]);
    expect(listing.truncated).toBe(true);
  });

  it("follows @odata.nextLink pagination", async () => {
    const mock = graphFetch({
      "/drives/d-me/items/root-1/children": (url) =>
        url.includes("page=2")
          ? Response.json({ value: [{ id: "b", name: "b.txt", file: {} }] })
          : Response.json({
              value: [{ id: "a", name: "a.txt", file: {} }],
              "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/d-me/items/root-1/children?page=2",
            }),
    });
    const listing = await listCabinet({ env: ENV, fetchImpl: mock.fetchImpl });
    expect(listing.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("readCabinetFile", () => {
  it("reads a text file's content", async () => {
    const mock = graphFetch();
    const text = await readCabinetFile({ env: ENV, fetchImpl: mock.fetchImpl }, { driveId: "d-me", itemId: "csv-1", name: "chase.csv" });
    expect(text).toContain("date,amount");
  });

  it("refuses binary formats by extension", async () => {
    const mock = graphFetch();
    await expect(
      readCabinetFile({ env: ENV, fetchImpl: mock.fetchImpl }, { driveId: "d-me", itemId: "x", name: "scan.pdf" }),
    ).rejects.toThrow(/not a text format/);
  });

  it("clips content past maxChars", async () => {
    const mock = graphFetch({ "/items/csv-1/content": () => new Response("x".repeat(100)) });
    const text = await readCabinetFile(
      { env: ENV, fetchImpl: mock.fetchImpl },
      { driveId: "d-me", itemId: "csv-1", name: "chase.csv" },
      { maxChars: 10 },
    );
    expect(text).toBe("x".repeat(10) + "\n…(truncated)");
  });
});

function fileEntry(path: string, over: Partial<CabinetListing["entries"][number]> = {}) {
  const name = path.split("/").pop()!;
  return { path, name, isFolder: false, size: 100, driveId: "d-me", itemId: `id-${name}`, ...over };
}

describe("selectFilesToInline", () => {
  const listing: CabinetListing = {
    root: "Cabinet",
    truncated: false,
    entries: [
      { path: "Finance", name: "Finance", isFolder: true, driveId: "d", itemId: "f" },
      fileEntry("Finance/old.csv", { lastModified: "2025-01-01T00:00:00Z" }),
      fileEntry("Finance/new.csv", { lastModified: "2026-07-15T00:00:00Z" }),
      fileEntry("Finance/README.md", { lastModified: "2024-01-01T00:00:00Z" }),
      fileEntry("Finance/scan.pdf", { lastModified: "2026-08-01T00:00:00Z" }),
      fileEntry("Finance/huge.csv", { lastModified: "2026-08-01T00:00:00Z", size: 999_999_999 }),
    ],
  };

  it("puts README/index files first even when older, then sorts by recency", () => {
    const picked = selectFilesToInline(listing).map((e) => e.path);
    expect(picked).toEqual(["Finance/README.md", "Finance/new.csv", "Finance/old.csv"]);
  });

  it("never selects non-text or oversized files, and respects maxFiles", () => {
    const picked = selectFilesToInline(listing, { maxFiles: 2 }).map((e) => e.path);
    expect(picked).toEqual(["Finance/README.md", "Finance/new.csv"]);
    expect(selectFilesToInline(listing).map((e) => e.name)).not.toContain("scan.pdf");
    expect(selectFilesToInline(listing).map((e) => e.name)).not.toContain("huge.csv");
  });
});

describe("inlineCabinetFiles", () => {
  it("reads the batch on ONE token refresh; a per-file failure becomes an error entry, not an aborted batch", async () => {
    const mock = graphFetch(); // csv-1 has content; doc-1 (notes.md) 404s
    const listing = await listCabinet({ env: ENV, fetchImpl: mock.fetchImpl });
    const inlined = await inlineCabinetFiles({ env: ENV, fetchImpl: mock.fetchImpl }, listing);
    const byPath = Object.fromEntries(inlined.map((f) => [f.path, f]));
    expect(byPath["Finance/chase.csv"]!.content).toContain("date,amount");
    expect(byPath["notes.md"]!.error).toMatch(/HTTP 404/);
    // newest first: chase.csv (07-15) before notes.md (07-01)
    expect(inlined.map((f) => f.path)).toEqual(["Finance/chase.csv", "notes.md"]);
    // listCabinet refreshed once, inlineCabinetFiles once — never per file
    const logins = mock.calls.filter((c) => c.url.includes("login.microsoftonline.com"));
    expect(logins).toHaveLength(2);
  });

  it("stops reading when the total character budget is spent", async () => {
    const mock = graphFetch({
      "/content": () => new Response("x".repeat(50)),
    });
    const listing: CabinetListing = {
      root: "Cabinet",
      truncated: false,
      entries: [
        fileEntry("a.csv", { lastModified: "2026-03-01T00:00:00Z" }),
        fileEntry("b.csv", { lastModified: "2026-02-01T00:00:00Z" }),
        fileEntry("c.csv", { lastModified: "2026-01-01T00:00:00Z" }),
      ],
    };
    const inlined = await inlineCabinetFiles({ env: ENV, fetchImpl: mock.fetchImpl }, listing, { charBudget: 80, perFileChars: 50 });
    // a: 50 chars; b: room 30 → clipped read; c: no room left
    expect(inlined.map((f) => f.path)).toEqual(["a.csv", "b.csv"]);
    expect(inlined[1]!.content).toContain("…(truncated)");
  });
});

describe("cabinetContentsMarkdown", () => {
  it("renders fenced content with modified stamp, and failures as honest notes", () => {
    const md = cabinetContentsMarkdown([
      { path: "Finance/chase.csv", lastModified: "2026-07-15T12:00:00Z", content: "date,amount" },
      { path: "notes.md", error: "HTTP 404" },
    ]);
    expect(md).toContain("#### Finance/chase.csv (modified 2026-07-15)");
    expect(md).toContain("date,amount");
    expect(md).toContain("_(read failed this run: HTTP 404)_");
  });

  it("says so when nothing qualified", () => {
    expect(cabinetContentsMarkdown([])).toContain("no text-format files qualified");
  });
});

describe("cabinetListingMarkdown", () => {
  it("renders one indented line per entry with size and modified date", () => {
    const md = cabinetListingMarkdown({
      root: "Cabinet",
      truncated: false,
      entries: [
        { path: "Finance", name: "Finance", isFolder: true, driveId: "d", itemId: "1" },
        { path: "Finance/chase.csv", name: "chase.csv", isFolder: false, size: 512, lastModified: "2026-07-15T12:00:00Z", driveId: "d", itemId: "2" },
      ],
    });
    expect(md).toContain("- Finance/ (folder)");
    expect(md).toContain("  - chase.csv (512 B, 2026-07-15)");
    expect(md).toContain("2 entries under Cabinet");
  });
});

describe("sourceSections", () => {
  it("inlines the live listing when configured", async () => {
    const mock = graphFetch();
    const sections = await sourceSections(["onedrive"], { env: ENV, fetchImpl: mock.fetchImpl });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("Filing cabinet (OneDrive via Microsoft Graph, read-only)");
    expect(sections[0]).toContain("chase.csv");
  });

  it("inlines budgeted file CONTENTS below the listing, with the not-read honesty rule stated", async () => {
    const mock = graphFetch();
    const sections = await sourceSections(["onedrive"], { env: ENV, fetchImpl: mock.fetchImpl });
    expect(sections[0]).toContain("Inlined file contents (budgeted)");
    expect(sections[0]).toContain("date,amount"); // actual CSV rows, not just the name
    expect(sections[0]).toContain("NOT read this run");
  });

  it("says so honestly when declared but unconfigured — and does not throw", async () => {
    const sections = await sourceSections(["onedrive"], { env: {} });
    expect(sections[0]).toContain("not configured");
  });

  it("turns a Graph outage into an honest section, never an aborted run", async () => {
    const mock = graphFetch({ "login.microsoftonline.com": () => new Response("AADSTS700082", { status: 400 }) });
    const sections = await sourceSections(["onedrive"], { env: ENV, fetchImpl: mock.fetchImpl });
    expect(sections[0]).toContain("configured but unreachable");
    expect(sections[0]).toContain("AADSTS700082");
  });

  it("names unknown sources instead of silently skipping them", async () => {
    const sections = await sourceSections(["dropbox"], { env: {} });
    expect(sections[0]).toContain("unknown source");
  });
});

/**
 * Ask-driven reads (v0.17.0): resolve a MODEL-named listing path — the
 * serving half of a read-request. PDFs are covered here (extracted on
 * request only, never in the ambient inline budget).
 */
describe("readCabinetPath", () => {
  it("resolves a listing path case-insensitively and reads it", async () => {
    const mock = graphFetch();
    const text = await readCabinetPath({ env: ENV, fetchImpl: mock.fetchImpl }, "finance/CHASE.csv");
    expect(text).toContain("date,amount");
  });

  it("extracts a requested PDF through the extractor seam", async () => {
    const mock = graphFetch({ "/items/leg-1/content": () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46])) });
    const calls: number[] = [];
    const text = await readCabinetPath({ env: ENV, fetchImpl: mock.fetchImpl }, "Shared/resolution.pdf", {
      maxChars: 500,
      pdfExtractor: async (data, opts) => {
        calls.push(data.length, opts.maxChars);
        return "EXTRACTED CLAUSE TEXT";
      },
    });
    expect(text).toBe("EXTRACTED CLAUSE TEXT");
    expect(calls).toEqual([4, 500]);
  });

  it("fails loud on a path that is not in the listing", async () => {
    const mock = graphFetch();
    await expect(
      readCabinetPath({ env: ENV, fetchImpl: mock.fetchImpl }, "Finance/never-existed.csv"),
    ).rejects.toThrow(/not in the cabinet listing/);
  });
});

describe("extractPdfText (real unpdf, minimal fixture)", () => {
  /** A valid one-page PDF built with computed xref offsets — ASCII only. */
  function minimalPdf(text: string): Uint8Array {
    const objects: string[] = [];
    objects[1] = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
    objects[2] = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
    objects[3] =
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n";
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objects[4] = `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
    objects[5] = "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
    let body = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let i = 1; i <= 5; i++) {
      offsets[i] = body.length;
      body += objects[i];
    }
    const xref = body.length;
    body +=
      "xref\n0 6\n0000000000 65535 f \n" +
      [1, 2, 3, 4, 5].map((i) => `${String(offsets[i]).padStart(10, "0")} 00000 n \n`).join("");
    body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new TextEncoder().encode(body);
  }

  it("extracts real text from PDF bytes", async () => {
    const text = await extractPdfText(minimalPdf("MESH DEMO 42"), { maxChars: 1000 });
    expect(text).toContain("MESH DEMO 42");
  });

  it("clips extracted text at maxChars with a visible note", async () => {
    const text = await extractPdfText(minimalPdf("A LONG LINE OF EXTRACTED PDF TEXT"), { maxChars: 10 });
    expect(text.length).toBeLessThan(40);
    expect(text).toContain("…(truncated)");
  });
});
