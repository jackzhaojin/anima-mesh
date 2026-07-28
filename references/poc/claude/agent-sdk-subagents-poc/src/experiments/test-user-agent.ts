import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(dirname(__dirname));

// Load environment variables
config({ path: join(PROJECT_ROOT, '.env') });

/**
 * Test that user-level agents in ~/.claude/agents/ are discoverable via
 * settingSources: ['user'].
 *
 * Deliberately generic: the expected agent names are read off the filesystem
 * rather than hardcoded, so this runs on any machine. (It previously asserted
 * on one developer's personal agent, which made it both machine-specific and
 * permanently green — the assertion substring-matched the agent name, which
 * appears in the response even when the model reports it does NOT exist.)
 */
async function testUserAgent(): Promise<void> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.MODEL || 'claude-sonnet-4-5';

  if (!oauthToken && !apiKey) {
    console.error('❌ No authentication credentials found');
    process.exit(1);
  }

  // Ground truth: what is actually on disk right now.
  const userAgentsDir = join(homedir(), '.claude', 'agents');
  const expected = existsSync(userAgentsDir)
    ? readdirSync(userAgentsDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''))
    : [];

  console.log('\n🧪 Testing User-Level Agent Discovery');
  console.log('═'.repeat(60));
  console.log(`Model: ${model}`);
  console.log(`Project Root: ${PROJECT_ROOT}`);
  console.log(`User agents dir: ${userAgentsDir}`);
  console.log(`On disk: ${expected.length > 0 ? expected.join(', ') : '(none)'}`);
  console.log('═'.repeat(60));

  if (expected.length === 0) {
    console.log('\n⏭️  SKIPPED: no user-level agents installed on this machine.');
    console.log('   Add a *.md agent to ~/.claude/agents/ to exercise this path.');
    return;
  }

  const testPrompt =
    'List all available subagents, including user-level agents from ~/.claude/agents/. ' +
    'Give the name of each one.';

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

    const lower = result.toLowerCase();
    const found = expected.filter((name) => lower.includes(name.toLowerCase()));
    const missing = expected.filter((name) => !lower.includes(name.toLowerCase()));

    console.log(`🔍 Discovered ${found.length}/${expected.length} user agents`);
    if (missing.length > 0) console.log(`   Missing: ${missing.join(', ')}`);
    console.log('═'.repeat(60));

    if (found.length === expected.length) {
      console.log('\n✅ PASS: all user-level agents were discoverable');
    } else {
      console.log('\n❌ FAIL: some user-level agents were not reported');
      process.exitCode = 1;
    }

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

testUserAgent().catch(console.error);
