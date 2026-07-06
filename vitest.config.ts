import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // The regression suite is the contract: everything in test/ must stay green.
  },
});
