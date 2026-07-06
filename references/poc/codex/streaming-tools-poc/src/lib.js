import path from "node:path";
import fs from "node:fs/promises";
import { Codex } from "@openai/codex-sdk";

export function createCodex(options = {}) {
  return new Codex(options);
}

export function defaultThreadOptions(overrides = {}) {
  return {
    workingDirectory: process.cwd(),
    approvalPolicy: "never",
    modelReasoningEffort: "low",
    webSearchEnabled: false,
    networkAccessEnabled: false,
    sandboxMode: "read-only",
    ...overrides,
  };
}

function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

function preview(value, maxLength = 140) {
  const normalized = oneLine(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatTodoItems(items) {
  return items.map((item) => `${item.completed ? "[x]" : "[ ]"} ${item.text}`).join(" | ");
}

function formatCommand(item) {
  const parts = [item.command];

  if (typeof item.exit_code === "number") {
    parts.push(`exit=${item.exit_code}`);
  }

  if (item.aggregated_output) {
    parts.push(`output=${preview(item.aggregated_output)}`);
  }

  return parts.join(" | ");
}

function formatFileChange(item) {
  const changes = item.changes.map((change) => `${change.kind}:${change.path}`).join(", ");
  return `${item.status} | ${changes}`;
}

function formatMcpTool(item) {
  return `${item.server}/${item.tool} | status=${item.status}`;
}

function formatItem(item) {
  switch (item.type) {
    case "agent_message":
      return preview(item.text, 200);
    case "reasoning":
      return preview(item.text, 200);
    case "command_execution":
      return formatCommand(item);
    case "file_change":
      return formatFileChange(item);
    case "mcp_tool_call":
      return formatMcpTool(item);
    case "web_search":
      return item.query;
    case "todo_list":
      return formatTodoItems(item.items);
    case "error":
      return item.message;
    default:
      return "";
  }
}

export function printEvent(event) {
  return formatEvent(event);
}

function formatEvent(event) {
  switch (event.type) {
    case "thread.started":
      return `[thread.started] ${event.thread_id}`;
    case "turn.started":
      return "[turn.started]";
    case "turn.completed":
      return `[turn.completed] input=${event.usage.input_tokens} cached=${event.usage.cached_input_tokens} output=${event.usage.output_tokens}`;
    case "turn.failed":
      return `[turn.failed] ${event.error.message}`;
    case "error":
      return `[error] ${event.message}`;
    case "item.started":
    case "item.updated":
    case "item.completed":
      return `[${event.type}:${event.item.type}] ${formatItem(event.item)}`;
    default:
      return `[unknown] ${JSON.stringify(event)}`;
  }
}

function createLogger(outputPath) {
  const lines = [];

  function log(line) {
    console.log(line);

    if (outputPath) {
      lines.push(line);
    }
  }

  async function flush() {
    if (!outputPath) {
      return;
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  }

  return { log, flush };
}

export async function runStreamedPrompt(prompt, options = {}) {
  const logger = createLogger(options.outputPath);
  const codex = createCodex(options.codexOptions);
  const thread = codex.startThread(defaultThreadOptions(options.threadOptions));
  const { events } = await thread.runStreamed(prompt);

  const summary = {
    threadId: null,
    itemTypes: new Set(),
    finalMessage: null,
  };

  for await (const event of events) {
    logger.log(printEvent(event));

    if (event.type === "thread.started") {
      summary.threadId = event.thread_id;
    }

    if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      summary.itemTypes.add(event.item.type);

      if (event.item.type === "agent_message") {
        summary.finalMessage = event.item.text;
      }
    }
  }

  logger.log(
    `[summary] thread=${summary.threadId ?? "unknown"} item_types=${Array.from(summary.itemTypes).join(", ") || "none"}`,
  );

  if (summary.finalMessage) {
    logger.log(`[final] ${oneLine(summary.finalMessage)}`);
  }

  await logger.flush();
  return summary;
}

export function outputFilePath() {
  return path.join(process.cwd(), "output", "hello-from-codex.txt");
}

export function traceFilePath(name) {
  return path.join(process.cwd(), "output", name);
}

export function summarizeTurn(turn, logger = console) {
  const itemTypes = [];

  for (const item of turn.items) {
    itemTypes.push(item.type);
    logger.log(`[item:${item.type}] ${formatItem(item)}`);
  }

  logger.log(
    `[turn.completed] input=${turn.usage?.input_tokens ?? 0} cached=${turn.usage?.cached_input_tokens ?? 0} output=${turn.usage?.output_tokens ?? 0}`,
  );
  logger.log(`[summary] item_types=${itemTypes.join(", ") || "none"}`);
  logger.log(`[final] ${oneLine(turn.finalResponse)}`);
}

export async function runBufferedPrompt(prompt, options = {}) {
  const logger = createLogger(options.outputPath);
  const codex = createCodex(options.codexOptions);
  const thread = codex.startThread(defaultThreadOptions(options.threadOptions));
  const turn = await thread.run(prompt);

  summarizeTurn(turn, logger);
  await logger.flush();
  return turn;
}
