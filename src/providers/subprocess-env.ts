/**
 * What a CLI harness subprocess (claude-code, opencode) inherits. The shell
 * env passes through as before; from the INSTANCE env (.env / .env.local)
 * only the harness's own auth variables are added, so an instance's Claude
 * token reaches `claude -p` the same way it reaches anthropic-api. Nothing
 * else crosses: an instance's Google refresh token, link tokens, or GitHub
 * credentials never land in an agent subprocess's environment.
 */
export const CLI_AUTH_ENV: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["CLAUDE_CODE_OAUTH_TOKEN"],
  opencode: ["MOONSHOT_API_KEY"],
};

/**
 * Shell keys a subscription harness must NOT inherit. `claude` prefers an
 * API key over the subscription login, so an exported one would silently
 * bill API credits; metered Claude is the `*-api-key` harnesses' choice.
 */
export const CLI_STRIP_ENV: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
};

/**
 * Shell env minus `strip`, with the `keys` taken from the instance env when
 * it sets them.
 */
export function subprocessEnv(
  instanceEnv: Record<string, string | undefined>,
  keys: readonly string[],
  strip: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of strip) delete env[key];
  for (const key of keys) {
    const value = instanceEnv[key];
    if (value) env[key] = value;
  }
  return env;
}

/**
 * The detail for a failed CLI run: stderr when it says anything, else
 * stdout. `claude -p` prints auth failures ("OAuth session expired") to
 * stdout with an empty stderr, which used to surface as a bare "exited 1:".
 */
export function failureDetail(stderr: string, stdout: string, max = 500): string {
  const detail = stderr.trim() || stdout.trim();
  return detail ? detail.slice(0, max) : "(no output on stderr or stdout)";
}
