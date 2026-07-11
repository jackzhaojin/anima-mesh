import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export { getEnv } from "./env-core.js";

/**
 * Minimal .env loader for instance secrets. No dependency, no interpolation,
 * no export keyword — KEY=VALUE lines, `#` comments, optional single/double
 * quotes. `.env.local` overrides `.env`. Values never leave the process:
 * channels read what they need by name and nothing logs them.
 */
export function loadInstanceEnv(instanceRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of [".env", ".env.local"]) {
    const abs = path.join(instanceRoot, file);
    if (!existsSync(abs)) continue;
    for (const rawLine of readFileSync(abs, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  }
  return out;
}
