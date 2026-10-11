import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { chmod } from "node:fs/promises";
import * as path from "node:path";
import { makeTree, cleanup } from "./helpers.js";
import { createClaudeCodeProvider, claudeCodeProvider } from "../src/providers/claude-code.js";
import { createOpencodeProvider } from "../src/providers/opencode.js";
import "../src/providers/node-providers.js";
import { resolveProvider } from "../src/providers/index.js";
import { failureDetail, subprocessEnv } from "../src/providers/subprocess-env.js";

/**
 * The CLI harnesses spawn real binaries, so these tests put fake `claude`
 * and `opencode` scripts first on PATH. Each script exits 3 if a non-auth
 * instance secret reached it, which is the leak these tests guard against.
 */
const FAKE_CLAUDE = `#!/bin/sh
if [ -n "$GOOGLE_READ_REFRESH_TOKEN" ]; then echo "leaked a non-auth secret"; exit 3; fi
if [ "$CLAUDE_CODE_OAUTH_TOKEN" = "instance-token-not-real" ]; then echo "brief via instance auth"; exit 0; fi
echo "Failed to authenticate: OAuth session expired and could not be refreshed"
exit 1
`;
const FAKE_OPENCODE = `#!/bin/sh
if [ -n "$GOOGLE_READ_REFRESH_TOKEN" ]; then echo "leaked a non-auth secret"; exit 3; fi
echo "no provider configured (moonshot key: \${MOONSHOT_API_KEY:-unset})"
exit 1
`;

let bin: string;
let work: string;

beforeAll(async () => {
  bin = await makeTree({ claude: FAKE_CLAUDE, opencode: FAKE_OPENCODE });
  await chmod(path.join(bin, "claude"), 0o755);
  await chmod(path.join(bin, "opencode"), 0o755);
  work = await makeTree({ "README.md": "instance\n" });
});
afterAll(async () => {
  await cleanup(bin);
  await cleanup(work);
});

function hermeticShell(): void {
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
  vi.stubEnv("MOONSHOT_API_KEY", "");
  vi.stubEnv("GOOGLE_READ_REFRESH_TOKEN", "");
}
afterEach(() => {
  vi.unstubAllEnvs();
});

const INSTANCE_ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: "instance-token-not-real",
  MOONSHOT_API_KEY: "instance-moonshot-not-real",
  GOOGLE_READ_REFRESH_TOKEN: "google-refresh-not-real",
};

describe("claude-code: instance auth and readable failures", () => {
  it("passes the instance's Claude token to `claude -p`, and no other instance secret", async () => {
    hermeticShell();
    const provider = createClaudeCodeProvider({ env: INSTANCE_ENV });
    const out = await provider.run({ prompt: "brief", cwd: work });
    expect(out.text).toBe("brief via instance auth");
  });

  it("resolveProvider binds claude-code to the run's instance env", async () => {
    hermeticShell();
    const out = await resolveProvider("claude-code", { env: INSTANCE_ENV }).run({ prompt: "brief", cwd: work });
    expect(out.text).toBe("brief via instance auth");
  });

  it("an auth failure printed on stdout reaches the error (it used to read 'exited 1:')", async () => {
    hermeticShell();
    await expect(claudeCodeProvider.run({ prompt: "brief", cwd: work })).rejects.toThrow(
      /claude-code exited 1: Failed to authenticate: OAuth session expired/,
    );
  });
});

describe("opencode: instance auth and readable failures", () => {
  it("serve gets the instance's provider key but not other secrets, and an early exit says why", async () => {
    hermeticShell();
    const provider = createOpencodeProvider({ env: INSTANCE_ENV });
    await expect(provider.run({ prompt: "brief", cwd: work })).rejects.toThrow(
      /opencode serve exited early \(code 1\): no provider configured \(moonshot key: instance-moonshot-not-real\)/,
    );
  });
});

describe("subprocess-env helpers", () => {
  it("failureDetail prefers stderr, falls back to stdout, and never returns blank", () => {
    expect(failureDetail("boom\n", "ignored")).toBe("boom");
    expect(failureDetail("  ", "Failed to authenticate\n")).toBe("Failed to authenticate");
    expect(failureDetail("", "")).toBe("(no output on stderr or stdout)");
    expect(failureDetail("", "x".repeat(900))).toHaveLength(500);
  });

  it("subprocessEnv keeps the shell env and lets the instance win only on listed keys", () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "shell-token");
    vi.stubEnv("SOME_SHELL_VAR", "kept");
    const env = subprocessEnv(INSTANCE_ENV, ["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("instance-token-not-real");
    expect(env.SOME_SHELL_VAR).toBe("kept");
    expect(env.GOOGLE_READ_REFRESH_TOKEN).not.toBe("google-refresh-not-real");
    expect(subprocessEnv({}, ["CLAUDE_CODE_OAUTH_TOKEN"]).CLAUDE_CODE_OAUTH_TOKEN).toBe("shell-token");
  });
});
