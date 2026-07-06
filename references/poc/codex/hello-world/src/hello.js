import { Codex } from "@openai/codex-sdk";

const workingDirectory = process.cwd();

async function main() {
  const codex = new Codex();

  const threadOptions = {
    workingDirectory,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    modelReasoningEffort: "low",
    webSearchEnabled: false,
    networkAccessEnabled: false,
  };

  const thread = codex.startThread(threadOptions);
  const turn = await thread.run(
    "Reply with exactly: Hello from Codex."
  );

  console.log(turn.finalResponse);
}

main().catch((error) => {
  console.error("Codex SDK hello-world failed.");
  console.error(error);
  process.exitCode = 1;
});
