import fs from "node:fs/promises";
import { outputFilePath, runStreamedPrompt, traceFilePath } from "./lib.js";

const prompt = `
Create a file at output/hello-from-codex.txt.

Write exactly this single line:
Hello from Codex write demo.

If the file already exists, overwrite it.
After writing the file, briefly confirm that it was created.
`;

await runStreamedPrompt(prompt, {
  outputPath: traceFilePath("stream-write-output.txt"),
  threadOptions: { sandboxMode: "workspace-write" },
});

const content = await fs.readFile(outputFilePath(), "utf8");
console.log(`[verification] ${content.trim()}`);
