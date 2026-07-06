import { runBufferedPrompt, traceFilePath } from "./lib.js";

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

await runBufferedPrompt(prompt, {
  outputPath: traceFilePath("buffered-tools-raw-reasoning-output.txt"),
  codexOptions: {
    config: {
      show_raw_agent_reasoning: true,
    },
  },
});
