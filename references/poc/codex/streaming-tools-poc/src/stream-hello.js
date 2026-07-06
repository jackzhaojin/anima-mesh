import { runStreamedPrompt, traceFilePath } from "./lib.js";

await runStreamedPrompt("Reply with exactly: Hello from Codex streamed.", {
  outputPath: traceFilePath("stream-hello-output.txt"),
});
