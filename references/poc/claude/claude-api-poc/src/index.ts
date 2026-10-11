import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { canReadFixture, childEnv, loadKey, redact } from "./config.js";

let key = "";
try {
  key = loadKey();
  const temporary = await mkdtemp(join(tmpdir(), "claude-api-poc-"));
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 120_000);
  let stream: ReturnType<typeof query> | undefined;
  try {
    const workspace = join(temporary, "workspace");
    const configDir = join(temporary, "config");
    await mkdir(workspace);
    await mkdir(configDir);
    const fixture = join(workspace, "challenge.txt");
    const challenge = `CLAUDE_API_POC_OK_${randomUUID()}`;
    await writeFile(fixture, `${challenge}\n`, { mode: 0o600 });
    let successfulReads = 0;
    let apiKeySource: string | undefined;
    let actualModel: string | undefined;
    let result: SDKResultMessage | undefined;
    console.log("Claude API PoC: starting SDK with API-key auth (key hidden).");
    stream = query({
      prompt: `Use Read to read ${fixture}. Return only the exact text from that file.`,
      options: {
        model: process.env.CLAUDE_API_MODEL || "haiku",
        cwd: workspace,
        env: childEnv(key, configDir),
        systemPrompt: "Read the requested fixture with the Read tool and return its contents verbatim.",
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        tools: ["Read"],
        permissionMode: "default",
        persistSession: false,
        maxTurns: 3,
        maxBudgetUsd: 0.10,
        thinking: { type: "disabled" },
        abortController,
        hooks: {
          PreToolUse: [{ hooks: [async (input) => ({
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: input.hook_event_name === "PreToolUse" &&
                canReadFixture(input.tool_name, input.tool_input, fixture) ? "allow" as const : "deny" as const,
              permissionDecisionReason: "This smoke test permits only its generated fixture.",
            },
          })] }],
          PostToolUse: [{ matcher: "Read", hooks: [async () => {
            successfulReads++;
            console.log("Tool: Read completed.");
            return {};
          }] }],
        },
      },
    });
    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        apiKeySource = message.apiKeySource;
        actualModel = message.model;
        console.log(`Model: ${actualModel}; API key source: ${apiKeySource}`);
      }
      if (message.type === "result") result = message;
    }
    if (!result) throw new Error("SDK stream ended without a result.");
    if (result.subtype !== "success") throw new Error(`SDK result: ${result.subtype}. ${result.errors.join("; ")}`);
    if (result.is_error) throw new Error(`Claude returned an error: ${result.result}`);
    if (apiKeySource !== "ANTHROPIC_API_KEY") throw new Error("ANTHROPIC_API_KEY authentication was not confirmed.");
    if (successfulReads < 1) throw new Error("No successful Read tool call was observed.");
    if (result.result.trim() !== challenge) throw new Error("Response did not match the generated fixture.");
    console.log(JSON.stringify({
      status: "PASS",
      model: actualModel,
      apiKeySource,
      successfulReads,
      exactResponseMatch: true,
      turns: result.num_turns,
      costUsd: result.total_cost_usd,
      durationMs: result.duration_ms,
      usage: result.usage,
    }, null, 2));
  } finally {
    clearTimeout(timeout);
    stream?.close();
    await rm(temporary, { recursive: true, force: true });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL: ${key ? redact(message, key) : message}`);
  process.exitCode = 1;
}
