/**
 * Agent SDK Skills POC - Comprehensive Test Suite
 *
 * This script runs all skill-related experiments and documents results.
 * Run with: npm run test:all
 */

import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, existsSync, mkdirSync } from 'fs';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(dirname(__dirname));

// Load environment variables
config({ path: join(PROJECT_ROOT, '.env') });

interface TestResult {
  name: string;
  description: string;
  config: Record<string, unknown>;
  prompt: string;
  success: boolean;
  output: string;
  error?: string;
  timestamp: string;
}

const results: TestResult[] = [];

async function runTest(
  name: string,
  description: string,
  prompt: string,
  options: Record<string, unknown>
): Promise<TestResult> {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log(`Description: ${description}`);
  console.log(`Prompt: "${prompt}"`);
  console.log(`Config: ${JSON.stringify(options, null, 2)}`);
  console.log(`${'─'.repeat(60)}`);

  const result: TestResult = {
    name,
    description,
    config: options,
    prompt,
    success: false,
    output: '',
    timestamp: new Date().toISOString()
  };

  try {
    const stream = query({
      prompt,
      options: {
        model: process.env.MODEL || 'claude-sonnet-4-5',
        maxTurns: 3,
        ...options
      }
    });

    let fullOutput = '';

    for await (const message of stream) {
      const msg = message as SDKMessage;

      if (msg.type === 'result') {
        const resultMsg = msg as SDKResultMessage;
        if (resultMsg.subtype === 'success') {
          fullOutput += resultMsg.result + '\n';
          result.success = true;
        } else {
          result.error = resultMsg.subtype;
          if ('errors' in resultMsg && resultMsg.errors) {
            result.error += ': ' + resultMsg.errors.join(', ');
          }
        }
      }
    }

    result.output = fullOutput.trim();
    console.log(`\nOutput:\n${result.output}`);
    console.log(`\nSuccess: ${result.success}`);

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error(`\nError: ${result.error}`);
  }

  return result;
}

async function main(): Promise<void> {
  console.log('\n🔬 Agent SDK Skills POC - Comprehensive Test Suite');
  console.log('═'.repeat(60));
  console.log(`Project Root: ${PROJECT_ROOT}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);

  // Validate authentication
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!oauthToken && !apiKey) {
    console.error('\n❌ Error: No authentication credentials found!');
    process.exit(1);
  }

  console.log(`Auth: ${oauthToken ? 'OAuth Token' : 'API Key'}`);
  console.log('═'.repeat(60));

  // ============================================================
  // EXPERIMENT 1: Baseline - No Skills Configuration
  // ============================================================
  results.push(await runTest(
    'Experiment 1: Baseline (No Skills Config)',
    'Query without settingSources or Skill in allowedTools - skills should NOT work',
    'What skills are available? List them.',
    {
      cwd: PROJECT_ROOT,
      // Intentionally NO settingSources
      // Intentionally NO 'Skill' in allowedTools
      allowedTools: ['Read', 'Bash']
    }
  ));

  // ============================================================
  // EXPERIMENT 2: settingSources only, no Skill tool
  // ============================================================
  results.push(await runTest(
    'Experiment 2: settingSources Only (No Skill Tool)',
    'Has settingSources but Skill NOT in allowedTools',
    'What skills are available? List them.',
    {
      cwd: PROJECT_ROOT,
      settingSources: ['user', 'project'],
      allowedTools: ['Read', 'Bash'] // NO 'Skill'
    }
  ));

  // ============================================================
  // EXPERIMENT 3: Skill tool only, no settingSources
  // ============================================================
  results.push(await runTest(
    'Experiment 3: Skill Tool Only (No settingSources)',
    'Has Skill in allowedTools but NO settingSources',
    'What skills are available? List them.',
    {
      cwd: PROJECT_ROOT,
      // NO settingSources
      allowedTools: ['Skill', 'Read', 'Bash']
    }
  ));

  // ============================================================
  // EXPERIMENT 4: Full Configuration - List Skills
  // ============================================================
  results.push(await runTest(
    'Experiment 4: Full Config - List Available Skills',
    'Full configuration with settingSources and Skill tool',
    'What skills are available? List them all with their descriptions.',
    {
      cwd: PROJECT_ROOT,
      settingSources: ['user', 'project'],
      allowedTools: ['Skill', 'Read', 'Bash']
    }
  ));

  // ============================================================
  // EXPERIMENT 5: User Skills Only
  // ============================================================
  results.push(await runTest(
    'Experiment 5: User Skills Only',
    'settingSources with only "user" - should only find ~/.claude/skills/',
    'What skills are available? List them.',
    {
      cwd: PROJECT_ROOT,
      settingSources: ['user'],
      allowedTools: ['Skill', 'Read', 'Bash']
    }
  ));

  // ============================================================
  // EXPERIMENT 6: Project Skills Only
  // ============================================================
  results.push(await runTest(
    'Experiment 6: Project Skills Only',
    'settingSources with only "project" - should only find ./.claude/skills/',
    'What skills are available? List them.',
    {
      cwd: PROJECT_ROOT,
      settingSources: ['project'],
      allowedTools: ['Skill', 'Read', 'Bash']
    }
  ));

  // ============================================================
  // EXPERIMENT 7: Trigger Bundled Project Skill
  // ============================================================
  results.push(await runTest(
    'Experiment 7: Trigger Bundled Project Skill',
    'Attempt to trigger the poc-test-skill bundled in .claude/skills/',
    'poc test - demonstrate the skills POC',
    {
      cwd: PROJECT_ROOT,
      settingSources: ['user', 'project'],
      allowedTools: ['Skill', 'Read', 'Bash']
    }
  ));

  // ============================================================
  // EXPERIMENT 8: Trigger User Skill
  // ============================================================
  results.push(await runTest(
    'Experiment 8: Trigger User Skill (conversation-logger)',
    'Attempt to trigger the conversation-logger skill from ~/.claude/skills/',
    'log this session',
    {
      cwd: PROJECT_ROOT,
      settingSources: ['user', 'project'],
      allowedTools: ['Skill', 'Read', 'Bash', 'Write']
    }
  ));

  // ============================================================
  // EXPERIMENT 9: Wrong CWD
  // ============================================================
  results.push(await runTest(
    'Experiment 9: Wrong CWD (Different Directory)',
    'Test with cwd pointing to a different directory - project skills should NOT load',
    'What skills are available? Is poc-test-skill available?',
    {
      cwd: '/tmp',  // Wrong directory
      settingSources: ['user', 'project'],
      allowedTools: ['Skill', 'Read', 'Bash']
    }
  ));

  // ============================================================
  // EXPERIMENT 10: No CWD specified
  // ============================================================
  results.push(await runTest(
    'Experiment 10: No CWD Specified',
    'Test without specifying cwd at all',
    'What skills are available? List them.',
    {
      // NO cwd
      settingSources: ['user', 'project'],
      allowedTools: ['Skill', 'Read', 'Bash']
    }
  ));

  // ============================================================
  // Generate Results Report
  // ============================================================
  console.log('\n\n');
  console.log('═'.repeat(60));
  console.log('TEST RESULTS SUMMARY');
  console.log('═'.repeat(60));

  let markdown = `# Agent SDK Skills POC - Test Results

Generated: ${new Date().toISOString()}
Project Root: ${PROJECT_ROOT}

## Summary

| # | Test | Result |
|---|------|--------|
`;

  results.forEach((r, i) => {
    const status = r.success ? '✅' : '❌';
    console.log(`${status} ${r.name}`);
    markdown += `| ${i + 1} | ${r.name} | ${r.success ? 'PASS' : 'FAIL'} |\n`;
  });

  markdown += `\n## Detailed Results\n\n`;

  results.forEach((r, i) => {
    markdown += `### ${i + 1}. ${r.name}

**Description**: ${r.description}

**Prompt**: \`${r.prompt}\`

**Config**:
\`\`\`json
${JSON.stringify(r.config, null, 2)}
\`\`\`

**Result**: ${r.success ? '✅ SUCCESS' : '❌ FAILED'}

**Output**:
\`\`\`
${r.output || 'No output'}
\`\`\`

${r.error ? `**Error**: ${r.error}\n\n` : ''}
---

`;
  });

  // Write results to file
  const resultsDir = join(PROJECT_ROOT, 'test-results');
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsFile = join(resultsDir, `test-run-${timestamp}.md`);
  writeFileSync(resultsFile, markdown);

  console.log(`\n📄 Results written to: ${resultsFile}`);
  console.log('═'.repeat(60));
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
