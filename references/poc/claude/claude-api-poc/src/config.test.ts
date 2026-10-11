import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canReadFixture, childEnv, loadKey, redact } from "./config.js";

test("loads only ANTHROPIC_API_KEY from the selected file without mutating process.env", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-api-config-test-"));
  const file = join(dir, ".env");
  const before = { ...process.env };
  try {
    writeFileSync(file, 'ANTHROPIC_API_KEY="fixture-key"\nUNRELATED_SECRET=ignored\n');
    assert.equal(loadKey({ CLAUDE_API_ENV_FILE: file, ANTHROPIC_API_KEY: "other-key" }), "fixture-key");
    // Compare as a boolean so test failures cannot print inherited secrets.
    assert.equal(isDeepStrictEqual({ ...process.env }, before), true);
    writeFileSync(file, "ANTHROPIC_API_KEY=\nCLAUDE_API_KEY=legacy-key\n");
    assert.throws(() => loadKey({ CLAUDE_API_ENV_FILE: file }), /nonempty ANTHROPIC_API_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts the standard exported API key without requiring an env file", () => {
  assert.equal(loadKey({ ANTHROPIC_API_KEY: " exported-key " }), "exported-key");
});

test("missing key fails rather than falling back to another credential", () => {
  assert.throws(() => loadKey({ CLAUDE_API_ENV_FILE: "/nonexistent/claude-api-poc.env" }), /Cannot read/);
});

test("subprocess receives only the requested key and cannot inherit OAuth or alternate endpoints", () => {
  const env = childEnv("fixture-key", "/temporary/config", {
    PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_AUTH_TOKEN: "token",
    ANTHROPIC_BASE_URL: "https://example.invalid", CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_API_KEY: "other", UNRELATED_SECRET: "private",
  });
  assert.equal(env.ANTHROPIC_API_KEY, "fixture-key");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/temporary/config");
  for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_API_KEY", "UNRELATED_SECRET"]) {
    assert.equal(env[name], undefined);
  }
});

test("tool gate denies other files and tools", () => {
  assert.equal(canReadFixture("Read", { file_path: "/fixture.txt" }, "/fixture.txt"), true);
  assert.equal(canReadFixture("Read", { file_path: "/.env.local" }, "/fixture.txt"), false);
  assert.equal(canReadFixture("Bash", { command: "pwd" }, "/fixture.txt"), false);
  assert.equal(canReadFixture("Read", null, "/fixture.txt"), false);
});

test("error output redacts the provided key", () => {
  assert.equal(redact("Error fixture-key sk-ant-example", "fixture-key"), "Error [REDACTED] [REDACTED]");
});
