import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

/**
 * Write a whole file atomically (v2.3.7): a temp file beside it, then a
 * rename. A sync client (OneDrive, Google Drive, Dropbox) uploads whatever
 * it sees; this way it sees either the old file or the new one, never half
 * of one. The temp name starts with a dot and does not end in .md, so no
 * loader reads it even if a crash leaves it behind.
 */
export function writeFileAtomic(abs: string, content: string): void {
  const dir = path.dirname(abs);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** True for "this path does not exist" errors - the only read failure that means absent. */
export function isMissing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * A read error that is NOT "missing", rethrown with a hint: in a synced
 * folder the usual cause is a cloud-only placeholder the client could not
 * download, and treating that as an absent file would let an agent report
 * a fact as missing when it is merely not on this machine.
 */
export function unreadable(abs: string, err: unknown): Error {
  const code = (err as { code?: string } | null)?.code ?? "error";
  return new Error(
    `could not read ${abs} (${code}). If this brain is in a synced folder (OneDrive, Google Drive, Dropbox), ` +
      `mark it "Always keep on this device" / available offline and try again.`,
  );
}
