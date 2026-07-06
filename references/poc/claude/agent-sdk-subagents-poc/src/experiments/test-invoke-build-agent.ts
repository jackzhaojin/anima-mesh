import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(dirname(__dirname));

// Load environment variables
config({ path: join(PROJECT_ROOT, '.env') });

/**
 * Test actually invoking jack-web-build-and-test-v1 to build something
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

  console.log('\n🧪 Testing Invocation: jack-web-build-and-test-v1');
  console.log('═'.repeat(60));
  console.log(`Model: ${model}`);
  console.log(`Project Root: ${PROJECT_ROOT}`);
  console.log(`Output Dir: ${outputDir}`);
  console.log('═'.repeat(60));

  // Test prompt - invoke the agent with a simple task
  const testPrompt = `Use the jack-web-build-and-test-v1 subagent to create a simple "Hello World" HTML page.

The page should:
1. Have a title "Hello World"
2. Display "Hello from Subagent POC!" as an h1
3. Include a button that shows an alert when clicked
4. Be saved to ${outputDir}/hello.html

This is a validation test - keep it simple.`;

  console.log(`\n📝 Test Prompt: Create simple Hello World page`);
  console.log(`📁 Output: ${outputDir}/hello.html`);
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
    for await (const message of stream) {
      const msg = message as SDKMessage;
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

    // Check if the file was created
    const outputFile = join(outputDir, 'hello.html');
    const fileCreated = existsSync(outputFile);
    console.log(`📄 File created: ${fileCreated ? '✅ YES' : '❌ NO'}`);

    // Check if subagent was invoked (look for indicators in result)
    const subagentInvoked = result.toLowerCase().includes('subagent') ||
                           result.toLowerCase().includes('task') ||
                           result.toLowerCase().includes('jack-web-build');
    console.log(`🤖 Subagent invoked: ${subagentInvoked ? '✅ YES' : '❌ UNCLEAR'}`);
    console.log('═'.repeat(60));

    if (fileCreated) {
      console.log('\n✅ SUCCESS: File was created by subagent workflow');
    } else {
      console.log('\n⚠️  File was not created - check output above');
    }

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

testInvokeBuildAgent().catch(console.error);
