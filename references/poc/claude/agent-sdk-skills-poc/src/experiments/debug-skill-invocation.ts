/**
 * Debug test for skill invocation
 *
 * This script captures ALL SDK messages to understand what happens
 * when a skill is triggered.
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(dirname(__dirname));

// Load environment variables
config({ path: join(PROJECT_ROOT, '.env') });

async function debugSkillInvocation(prompt: string): Promise<void> {
  console.log('\n' + '═'.repeat(70));
  console.log(`DEBUG: Skill Invocation Test`);
  console.log(`Prompt: "${prompt}"`);
  console.log('═'.repeat(70));

  const stream = query({
    prompt,
    options: {
      model: process.env.MODEL || 'claude-sonnet-4-5',
      maxTurns: 5,
      cwd: PROJECT_ROOT,
      settingSources: ['user', 'project'],
      allowedTools: ['Skill', 'Read', 'Bash', 'Write']
    }
  });

  let messageCount = 0;

  for await (const message of stream) {
    messageCount++;
    const msg = message as SDKMessage;

    console.log(`\n--- Message ${messageCount} ---`);
    console.log(`Type: ${msg.type}`);

    // Log all properties of the message
    console.log(`Full message: ${JSON.stringify(msg, null, 2).slice(0, 2000)}`);

    // Check for specific message types
    if (msg.type === 'result') {
      console.log(`\n>>> RESULT MESSAGE <<<`);
      console.log(`Subtype: ${(msg as Record<string, unknown>).subtype}`);
      console.log(`Result: ${(msg as Record<string, unknown>).result}`);
    }

    if (msg.type === 'assistant') {
      console.log(`\n>>> ASSISTANT MESSAGE <<<`);
      const content = (msg as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        content.forEach((block: Record<string, unknown>, i: number) => {
          console.log(`  Block ${i}: type=${block.type}`);
          if (block.type === 'tool_use') {
            console.log(`    Tool: ${block.name}`);
            console.log(`    Input: ${JSON.stringify(block.input)}`);
          }
          if (block.type === 'text') {
            console.log(`    Text: ${String(block.text).slice(0, 500)}`);
          }
        });
      }
    }

    if (msg.type === 'user') {
      console.log(`\n>>> USER/TOOL_RESULT MESSAGE <<<`);
      const content = (msg as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        content.forEach((block: Record<string, unknown>, i: number) => {
          console.log(`  Block ${i}: type=${block.type}`);
          if (block.type === 'tool_result') {
            console.log(`    Tool Use ID: ${block.tool_use_id}`);
            console.log(`    Content: ${JSON.stringify(block.content).slice(0, 500)}`);
          }
        });
      }
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`Total messages: ${messageCount}`);
  console.log('═'.repeat(70));
}

async function main(): Promise<void> {
  console.log('\n🔬 Debug: Skill Invocation Analysis');
  console.log(`Project Root: ${PROJECT_ROOT}`);

  // Test 1: Try to trigger poc-test-skill (bundled project skill)
  console.log('\n\n🧪 TEST 1: Bundled Project Skill');
  await debugSkillInvocation('poc test - use the poc-test-skill to demonstrate skills work');

  // Test 2: Try to trigger user skill
  console.log('\n\n🧪 TEST 2: User Skill (conversation-logger)');
  await debugSkillInvocation('I want to log this session - use the conversation-logger skill');
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
