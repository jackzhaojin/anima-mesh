/**
 * Env resolution with no filesystem dependency — safe to import from Workers
 * code (the fs-backed loader lives in env.ts, which is Node-only).
 */

/** Injected env first, process env as fallback (guarded: Workers have no `process`). */
export function getEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  return env[key] ?? (typeof process !== "undefined" ? process.env[key] : undefined);
}
