import { mkdir, readFile, writeFile, rename, rm, chmod } from "node:fs/promises";
import * as path from "node:path";
import { createMsGraphTokenManager, type MsGraphCredential } from "./msgraph-auth.js";
import type { SourceContext } from "./types.js";

/** Node-only private cache. local-only/ is excluded from git and source listings. */
export function localMsGraphTokenManager(root: string, ctx: SourceContext): () => Promise<string> {
  const directory = path.join(root, "local-only", "credentials");
  const file = path.join(directory, "msgraph.json");
  return createMsGraphTokenManager(ctx, {
    async load() {
      try {
        const saved = JSON.parse(await readFile(file, "utf8")) as MsGraphCredential;
        if (typeof saved.bootstrapHash !== "string" || typeof saved.refreshToken !== "string" || !saved.refreshToken) {
          throw new Error("invalid credential cache");
        }
        return saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("msgraph: private credential cache could not be read");
      }
    },
    async save(value) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      // Existing instances may predate local-only/ in the root .gitignore.
      // Establish the cache's own exclusion before writing any credential.
      await writeFile(path.join(directory, ".gitignore"), "*\n", { mode: 0o600 });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  });
}
