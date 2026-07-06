import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** Write a set of relPath → content files into a fresh temp dir; returns its root. */
export async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "animamesh-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

export async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export function concept(type: string, extra: Record<string, unknown>, body: string): string {
  const fmLines = [`type: ${type}`];
  for (const [k, v] of Object.entries(extra)) {
    fmLines.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return `---\n${fmLines.join("\n")}\n---\n\n${body}\n`;
}

/** Smallest bundle that passes the `okf` profile. */
export function minimalOkfFiles(): Record<string, string> {
  return {
    "index.md": concept("index", {}, "# Index\n"),
    "log.md": concept("log", {}, "# Log\n"),
  };
}

/** Smallest bundle that passes the `animamesh` profile. */
export function minimalAnimaMeshFiles(): Record<string, string> {
  return {
    ...minimalOkfFiles(),
    "constitution.md": concept("constitution", { immutable: true }, "# Constitution\n"),
  };
}
