import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import * as readline from 'readline';
import { config } from 'dotenv';

// Load environment variables
config();

/**
 * Main chat application using Claude Agent SDK with OAuth authentication
 */
async function main(): Promise<void> {
  // Get authentication credentials from environment
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.MODEL || 'claude-opus-4-5';

  // Validate authentication
  if (!oauthToken && !apiKey) {
    console.error('\n❌ Error: No authentication credentials found!');
    console.error('\nPlease set one of the following in your .env file:');
    console.error('  • CLAUDE_CODE_OAUTH_TOKEN (run "claude setup-token" to get this)');
    console.error('  • ANTHROPIC_API_KEY (get from https://console.anthropic.com/)\n');
    process.exit(1);
  }

  console.log('\n🤖 Claude Agent SDK Chat Demo');
  console.log('═'.repeat(50));
  console.log(`Model: ${model}`);
  console.log(`Auth: ${oauthToken ? 'OAuth Token' : 'API Key'}`);
  console.log('═'.repeat(50));
  console.log('Type your message and press Enter. Type "exit" or "quit" to end.\n');

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

      // Query Claude using the Agent SDK
      // Authentication is handled automatically via environment variables
      const stream = query({
        prompt: userMessage,
        options: {
          model,
          maxTurns: 10
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
