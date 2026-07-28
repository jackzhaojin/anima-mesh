import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync, rmSync } from 'fs';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(dirname(__dirname));

// Load environment variables
config({ path: join(PROJECT_ROOT, '.env') });

// The subagent under test. `general-purpose` is a built-in, so this experiment
// works on any machine — it must not depend on a personal ~/.claude/agents entry.
const TARGET_AGENT = 'general-purpose';

/**
 * Test actually invoking a subagent to build something, and verify via the
 * message stream (not string matching) that delegation really happened.
 */
async function testInvokeBuildAgent(): Promise<void> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.MODEL || 'claude-sonnet-4-5';

  if (!oauthToken && !apiKey) {
    console.error('❌ No authentication credentials found');
    process.exit(1);
  }

  // Create a temp output directory for the test
  const outputDir = join(PROJECT_ROOT, 'test-output');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Clear the target first — otherwise a leftover file makes the assertion
  // below pass without the agent having done anything.
  const outputFile = join(outputDir, 'hello.html');
  rmSync(outputFile, { force: true });

  console.log(`\n🧪 Testing Invocation: ${TARGET_AGENT}`);
  console.log('═'.repeat(60));
  console.log(`Model: ${model}`);
  console.log(`Project Root: ${PROJECT_ROOT}`);
  console.log(`Output Dir: ${outputDir}`);
  console.log('═'.repeat(60));

  // Test prompt - invoke the agent with a simple task
  const testPrompt = `Use the ${TARGET_AGENT} subagent to create a simple "Hello World" HTML page.

The page should:
1. Have a title "Hello World"
2. Display "Hello from Subagent POC!" as an h1
3. Include a button that shows an alert when clicked
4. Be saved to ${outputFile}

This is a validation test - keep it simple.`;

  console.log(`\n📝 Test Prompt: Create simple Hello World page`);
  console.log(`📁 Output: ${outputFile}`);
  console.log('\n🔄 Running query (invoking subagent)...\n');

  try {
    const startTime = Date.now();

    const stream = query({
      prompt: testPrompt,
      options: {
        model,
        maxTurns: 30,  // Give it room to work
        cwd: PROJECT_ROOT,
        settingSources: ['user', 'project'],
        allowedTools: ['Task', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']
      }
    });

    let result = '';
    // Ground truth for delegation: an actual Task tool_use block in the stream.
    const delegatedTo: string[] = [];

    for await (const message of stream) {
      const msg = message as SDKMessage;

      if (msg.type === 'assistant') {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && block.name === 'Task') {
              delegatedTo.push(String(block.input?.subagent_type ?? 'unknown'));
            }
          }
        }
      }

      if (msg.type === 'result') {
        const resultMsg = msg as SDKResultMessage;
        if (resultMsg.subtype === 'success') {
          result = resultMsg.result || '';
          console.log('Claude:', result);
        } else {
          console.error('❌ Error:', resultMsg.subtype);
          if ('errors' in resultMsg && resultMsg.errors) {
            resultMsg.errors.forEach(err => console.error('  -', err));
          }
        }
      }
    }

    const duration = Date.now() - startTime;
    console.log('\n' + '═'.repeat(60));
    console.log(`⏱️  Duration: ${duration}ms`);

    const fileCreated = existsSync(outputFile);
    console.log(`📄 File created: ${fileCreated ? '✅ YES' : '❌ NO'}`);
    console.log(
      `🤖 Task tool used: ${delegatedTo.length > 0 ? `✅ YES (${delegatedTo.join(', ')})` : '❌ NO'}`
    );
    console.log('═'.repeat(60));

    const passed = fileCreated && delegatedTo.includes(TARGET_AGENT);
    if (passed) {
      console.log(`\n✅ SUCCESS: ${TARGET_AGENT} was invoked and the file was created`);
    } else if (fileCreated) {
      console.log('\n⚠️  File was created, but not via the expected subagent');
      process.exitCode = 1;
    } else {
      console.log('\n❌ FAIL: file was not created - check output above');
      process.exitCode = 1;
    }

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

testInvokeBuildAgent().catch(console.error);
