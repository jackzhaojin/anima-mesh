import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import * as readline from 'readline';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(__dirname);

// Load environment variables
config();

/**
 * Subagents POC - Interactive CLI with Subagent Support
 *
 * This POC tests:
 * 1. Filesystem-based subagents from .claude/agents/
 * 2. Task tool invocation for subagent delegation
 * 3. Subagent isolation and context management
 */
async function main(): Promise<void> {
  // Get authentication credentials from environment
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.MODEL || 'claude-sonnet-4-5';

  // Validate authentication
  if (!oauthToken && !apiKey) {
    console.error('\n❌ Error: No authentication credentials found!');
    console.error('\nPlease set one of the following in your .env file:');
    console.error('  • CLAUDE_CODE_OAUTH_TOKEN (run "claude setup-token" to get this)');
    console.error('  • ANTHROPIC_API_KEY (get from https://console.anthropic.com/)\n');
    process.exit(1);
  }

  console.log('\n🤖 Agent SDK Subagents POC');
  console.log('═'.repeat(60));
  console.log(`Model: ${model}`);
  console.log(`Auth: ${oauthToken ? 'OAuth Token' : 'API Key'}`);
  console.log(`Project Root (cwd): ${PROJECT_ROOT}`);
  console.log('═'.repeat(60));
  console.log('\n📋 Configuration:');
  console.log('  • settingSources: ["user", "project"]');
  console.log('  • allowedTools: ["Task", "Read", "Bash", ...] (Task enables subagents)');
  console.log('  • Subagents location: .claude/agents/');
  console.log('═'.repeat(60));
  console.log('\n📂 Available Subagents:');
  console.log('  • task-researcher - Research tasks before implementation');
  console.log('  • code-validator - Validate code changes');
  console.log('  • Explore (built-in) - Fast codebase exploration');
  console.log('  • general-purpose (built-in) - Complex multi-step tasks');
  console.log('═'.repeat(60));
  console.log('\n💡 Test prompts:');
  console.log('  • "Use task-researcher to understand this project structure"');
  console.log('  • "Research how the package.json is configured"');
  console.log('  • "Have the code-validator check the src/ directory"');
  console.log('  • "Explore the .claude/agents/ folder"');
  console.log('\nType "exit" or "quit" to end.\n');

  // Create readline interface for CLI interaction
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: '
  });

  // Start the interactive chat loop
  rl.prompt();

  rl.on('line', async (input: string) => {
    const userMessage = input.trim();

    // Handle exit commands
    if (userMessage.toLowerCase() === 'exit' || userMessage.toLowerCase() === 'quit') {
      console.log('\n👋 Goodbye!\n');
      rl.close();
      process.exit(0);
    }

    // Skip empty messages
    if (!userMessage) {
      rl.prompt();
      return;
    }

    try {
      console.log('\nClaude: ');

      // Query Claude with Subagents enabled
      // Key settings for subagents:
      // 1. settingSources: ['user', 'project'] - loads agents from filesystem
      // 2. allowedTools with 'Task' - enables the Task tool for subagent delegation
      // 3. cwd - tells SDK where to find .claude/agents/
      const stream = query({
        prompt: userMessage,
        options: {
          model,
          maxTurns: 25,
          cwd: PROJECT_ROOT,
          settingSources: ['user', 'project'],
          // Task tool is the key - it enables subagent delegation
          allowedTools: ['Task', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']
        }
      });

      // Process the streaming response
      for await (const message of stream) {
        const msg = message as SDKMessage;

        // Handle result message
        if (msg.type === 'result') {
          const resultMsg = msg as SDKResultMessage;
          if (resultMsg.subtype === 'success') {
            console.log(resultMsg.result);
          } else {
            // Handle error results
            console.error('\n❌ Error:', resultMsg.subtype);
            if ('errors' in resultMsg && resultMsg.errors) {
              resultMsg.errors.forEach(err => console.error('  -', err));
            }
          }
        }
      }

      console.log('\n');
    } catch (error) {
      console.error('\n❌ Error:', error instanceof Error ? error.message : String(error));

      if (error instanceof Error && error.message.includes('authentication')) {
        console.error('\nPlease check your authentication credentials:');
        console.error('  • OAuth token: Run "claude setup-token"');
        console.error('  • API key: Get from https://console.anthropic.com/\n');
      }
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n👋 Goodbye!\n');
    process.exit(0);
  });
}

// Run the application
main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
