/**
 * Extended Skills Test
 *
 * Tests:
 * 1. project-analyzer skill with script execution
 * 2. conversation-logger skill with real file creation
 */

import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(dirname(__dirname));

config({ path: join(PROJECT_ROOT, '.env') });

interface TestResult {
  name: string;
  prompt: string;
  success: boolean;
  output: string;
  toolsUsed: string[];
  error?: string;
}

async function runExtendedTest(
  name: string,
  prompt: string,
  maxTurns: number = 10
): Promise<TestResult> {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`TEST: ${name}`);
  console.log(`Prompt: "${prompt}"`);
  console.log(`Max Turns: ${maxTurns}`);
  console.log(`${'─'.repeat(70)}`);

  const result: TestResult = {
    name,
    prompt,
    success: false,
    output: '',
    toolsUsed: []
  };

  try {
    const stream = query({
      prompt,
      options: {
        model: process.env.MODEL || 'claude-sonnet-4-5',
        maxTurns,
        cwd: PROJECT_ROOT,
        settingSources: ['user', 'project'],
        allowedTools: ['Skill', 'Read', 'Bash', 'Write', 'Glob', 'Grep']
      }
    });

    for await (const message of stream) {
      const msg = message as SDKMessage;

      // Track tool usage
      if (msg.type === 'assistant') {
        const content = (msg as Record<string, unknown>).message as Record<string, unknown>;
        const blocks = (content?.content as Array<Record<string, unknown>>) || [];
        blocks.forEach(block => {
          if (block.type === 'tool_use') {
            const toolName = block.name as string;
            if (!result.toolsUsed.includes(toolName)) {
              result.toolsUsed.push(toolName);
            }
            console.log(`  → Tool: ${toolName}`);
            if (block.input) {
              const input = block.input as Record<string, unknown>;
              if (input.skill) console.log(`    Skill: ${input.skill}`);
              if (input.command) console.log(`    Command: ${String(input.command).slice(0, 100)}`);
            }
          }
        });
      }

      // Capture final result
      if (msg.type === 'result') {
        const resultMsg = msg as SDKResultMessage;
        if (resultMsg.subtype === 'success') {
          result.output = resultMsg.result || '';
          result.success = true;
        } else {
          result.error = resultMsg.subtype;
        }
      }
    }

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`Tools Used: ${result.toolsUsed.join(', ') || 'None'}`);
    console.log(`Success: ${result.success}`);
    console.log(`\nOutput Preview (first 500 chars):`);
    console.log(result.output.slice(0, 500));

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${result.error}`);
  }

  return result;
}

async function main(): Promise<void> {
  console.log('\n🔬 Extended Skills Test Suite');
  console.log('═'.repeat(70));
  console.log(`Project Root: ${PROJECT_ROOT}`);

  const results: TestResult[] = [];

  // Test 1: Project Analyzer with Script
  console.log('\n\n📊 TEST 1: Project Analyzer (Script Execution)');
  results.push(await runExtendedTest(
    'Project Analyzer Skill',
    'Analyze this project using the project-analyzer skill. Run the analysis script and show me the results.',
    15
  ));

  // Test 2: Conversation Logger with Real Output
  console.log('\n\n📝 TEST 2: Conversation Logger (Real File Creation)');
  results.push(await runExtendedTest(
    'Conversation Logger Skill',
    'Log this conversation session. Create a prompt-log.md file in the project root. The session had one prompt: "Testing the conversation logger skill" and the response was "Successfully tested".',
    15
  ));

  // Test 3: Skill Discovery
  console.log('\n\n🔍 TEST 3: Skill Auto-Discovery');
  results.push(await runExtendedTest(
    'Skill Discovery',
    'What skills are available in this project? List the project-specific ones.',
    5
  ));

  // Summary
  console.log('\n\n');
  console.log('═'.repeat(70));
  console.log('TEST SUMMARY');
  console.log('═'.repeat(70));

  results.forEach(r => {
    const status = r.success ? '✅' : '❌';
    console.log(`${status} ${r.name}`);
    console.log(`   Tools: ${r.toolsUsed.join(', ') || 'None'}`);
    if (r.error) console.log(`   Error: ${r.error}`);
  });

  // Write results
  const resultsDir = join(PROJECT_ROOT, 'test-results');
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsFile = join(resultsDir, `extended-test-${timestamp}.json`);
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`\n📄 Results: ${resultsFile}`);
}

main().catch(console.error);
