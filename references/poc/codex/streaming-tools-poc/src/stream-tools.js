import { runStreamedPrompt, traceFilePath } from "./lib.js";

const prompt = `
Inspect the current folder.

Use shell commands to:
1. Print the current directory.
2. List the top-level files.
3. Read package.json.

Then answer with:
- the package name
- the available npm scripts

Do not modify any files.
`;

await runStreamedPrompt(prompt, {
  outputPath: traceFilePath("stream-tools-output.txt"),
});
