import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(dirname(__dirname));

// Load environment variables
config({ path: join(PROJECT_ROOT, '.env') });

interface TestResult {
  name: string;
  prompt: string;
  passed: boolean;
  evidence: string;
  duration: number;
}

/**
 * Test suite for subagent capabilities
 */
async function runTests(): Promise<void> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.MODEL || 'claude-sonnet-4-5';

  if (!oauthToken && !apiKey) {
    console.error('❌ No authentication credentials found');
    process.exit(1);
  }

  console.log('\n🧪 Subagents POC Test Suite');
  console.log('═'.repeat(60));
  console.log(`Model: ${model}`);
  console.log(`Project Root: ${PROJECT_ROOT}`);
  console.log('═'.repeat(60));

  const results: TestResult[] = [];

  // Test 1: Verify Task tool is available
  const test1 = await runTest({
    name: 'Task tool availability',
    prompt: 'List what tools you have available. Specifically mention if you have the Task tool.',
    expectedEvidence: 'Task',
    model
  });
  results.push(test1);

  // Test 2: Invoke custom subagent (task-researcher)
  const test2 = await runTest({
    name: 'Custom subagent invocation (task-researcher)',
    prompt: 'Use the task-researcher subagent to analyze this project\'s package.json file. Report what the subagent finds.',
    expectedEvidence: 'task-researcher',
    model
  });
  results.push(test2);

  // Test 3: Invoke built-in Explore subagent
  const test3 = await runTest({
    name: 'Built-in Explore subagent',
    prompt: 'Use the Explore subagent to find all TypeScript files in this project.',
    expectedEvidence: 'Explore',
    model
  });
  results.push(test3);

  // Test 4: Verify subagent context isolation
  const test4 = await runTest({
    name: 'Subagent context isolation',
    prompt: 'Spawn a subagent to read the README of this project if it exists. Confirm the subagent completed its work independently.',
    expectedEvidence: 'subagent',
    model
  });
  results.push(test4);

  // Print summary
  console.log('\n' + '═'.repeat(60));
  console.log('📊 TEST RESULTS SUMMARY');
  console.log('═'.repeat(60));

  let passed = 0;
  let failed = 0;

  for (const result of results) {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`\n${status}: ${result.name}`);
    console.log(`   Duration: ${result.duration}ms`);
    if (!result.passed) {
      console.log(`   Evidence: ${result.evidence.substring(0, 200)}...`);
    }
    result.passed ? passed++ : failed++;
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log('═'.repeat(60));

  // Save results
  const resultsDir = join(PROJECT_ROOT, 'test-results');
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsFile = join(resultsDir, `subagent-test-${timestamp}.json`);
  writeFileSync(resultsFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    model,
    projectRoot: PROJECT_ROOT,
    results,
    summary: { total: results.length, passed, failed }
  }, null, 2));

  console.log(`\n📁 Results saved to: ${resultsFile}\n`);

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

async function runTest(config: {
  name: string;
  prompt: string;
  expectedEvidence: string;
  model: string;
}): Promise<TestResult> {
  console.log(`\n🔄 Running: ${config.name}`);
  console.log(`   Prompt: "${config.prompt.substring(0, 50)}..."`);

  const startTime = Date.now();
  let result = '';

  try {
    const stream = query({
      prompt: config.prompt,
      options: {
        model: config.model,
        maxTurns: 15,
        cwd: PROJECT_ROOT,
        settingSources: ['user', 'project'],
        allowedTools: ['Task', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']
      }
    });

    for await (const message of stream) {
      const msg = message as SDKMessage;
      if (msg.type === 'result') {
        const resultMsg = msg as SDKResultMessage;
        if (resultMsg.subtype === 'success') {
          result = resultMsg.result || '';
        }
      }
    }

    const duration = Date.now() - startTime;
    const passed = result.toLowerCase().includes(config.expectedEvidence.toLowerCase());

    console.log(`   ${passed ? '✅' : '❌'} Completed in ${duration}ms`);

    return {
      name: config.name,
      prompt: config.prompt,
      passed,
      evidence: result,
      duration
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);

    return {
      name: config.name,
      prompt: config.prompt,
      passed: false,
      evidence: `Error: ${error instanceof Error ? error.message : String(error)}`,
      duration
    };
  }
}

// Run tests
runTests().catch(console.error);
