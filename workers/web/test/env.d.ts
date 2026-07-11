import type { Env } from "../src/env.js";

declare module "cloudflare:test" {
  // The `env` provided to tests is the production Env contract.
  interface ProvidedEnv extends Env {}
}
