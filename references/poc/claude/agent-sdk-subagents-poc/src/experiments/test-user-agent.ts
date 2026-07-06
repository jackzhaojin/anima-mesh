import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(dirname(__dirname));

// Load environment variables
config({ path: join(PROJECT_ROOT, '.env') });

/**
 * Test invoking user-level agent: jack-web-build-and-test-v1
 */
async function testUserAgent(): Promise<void> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.MODEL || 'claude-sonnet-4-5';

  if (!oauthToken && !apiKey) {
    console.error('❌ No authentication credentials found');
    process.exit(1);
  }

  console.log('\n🧪 Testing User-Level Agent: jack-web-build-and-test-v1');
  console.log('═'.repeat(60));
  console.log(`Model: ${model}`);
  console.log(`Project Root: ${PROJECT_ROOT}`);
  console.log('═'.repeat(60));

  // Test prompt - ask to use the specific agent
  const testPrompt = `List all available subagents including user-level agents from ~/.claude/agents/.
Specifically check if "jack-web-build-and-test-v1" is available and describe what it does.`;

  console.log(`\n📝 Test Prompt: "${testPrompt.substring(0, 60)}..."`);
  console.log('\n🔄 Running query...\n');

  try {
    const startTime = Date.now();

    const stream = query({
      prompt: testPrompt,
      options: {
        model,
        maxTurns: 10,
        cwd: PROJECT_ROOT,
        settingSources: ['user', 'project'],  // 'user' loads from ~/.claude/agents/
        allowedTools: ['Task', 'Read', 'Glob', 'Grep', 'Bash']
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
        }
      }
    }

    const duration = Date.now() - startTime;
    console.log('\n' + '═'.repeat(60));
    console.log(`⏱️  Duration: ${duration}ms`);

    // Check if agent was found
    const found = result.toLowerCase().includes('jack-web-build-and-test') ||
                  result.toLowerCase().includes('jack-web-build');
    console.log(`🔍 Agent found: ${found ? '✅ YES' : '❌ NO'}`);
    console.log('═'.repeat(60));

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

testUserAgent().catch(console.error);
