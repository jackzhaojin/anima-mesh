# Claude Agent SDK OAuth Demo (TypeScript)

A command-line chat application demonstrating the Claude Agent SDK with OAuth token authentication. This TypeScript implementation is based on [weidwonder/claude_agent_sdk_oauth_demo](https://github.com/weidwonder/claude_agent_sdk_oauth_demo).

## What This Demo Does

This is a simple CLI chat interface that lets you have conversations with Claude using either:
- **OAuth Token** - For Claude Pro/Max subscribers (uses your subscription quota)
- **API Key** - For developers and enterprises (pay-per-use)

## Prerequisites

- **Node.js** 18 or higher
- One of the following authentication methods:
  - Claude Pro/Max subscription (for OAuth)
  - Anthropic API key (for API access)

## Installation

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env and add your credentials (see Configuration below)
```

## Configuration

### Option 1: OAuth Token (Claude Pro/Max Subscribers)

If you have a Claude Pro or Max subscription:

```bash
# Install Claude CLI globally (if not already installed)
npm install -g @anthropic-ai/claude-cli

# Set up OAuth token (this will open your browser for authentication)
claude setup-token

# The token will be automatically configured
# Or you can manually add it to .env:
# CLAUDE_CODE_OAUTH_TOKEN=your_token_here
```

### Option 2: API Key (Developers)

If you have an Anthropic API key:

1. Get your API key from [https://console.anthropic.com/](https://console.anthropic.com/)
2. Add it to your `.env` file:

```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### Optional Configuration

You can specify which Claude model to use (defaults to `claude-sonnet-4-5`):

```bash
MODEL=claude-sonnet-4-5
```

## Usage

### Development Mode (with auto-recompile)

```bash
npm run dev
```

### Production Mode

```bash
# Build TypeScript to JavaScript
npm run build

# Run the compiled application
npm start
```

### Interactive Chat

Once running, you'll see:

```
🤖 Claude Agent SDK Chat Demo
══════════════════════════════════════════════════
Model: claude-sonnet-4-5
Auth: OAuth Token
══════════════════════════════════════════════════
Type your message and press Enter. Type "exit" or "quit" to end.

You:
```

Type your message and press Enter to chat with Claude. Type `exit` or `quit` to end the conversation.

## Project Structure

```
chat-cli/
├── src/
│   └── index.ts          # Main TypeScript application
├── dist/                 # Compiled JavaScript (generated)
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── .env.example          # Environment template
└── README.md            # This file
```

## Key Features

- **TypeScript** - Fully typed implementation
- **OAuth Support** - Use your Claude Pro/Max subscription
- **API Key Support** - Alternative authentication method
- **Streaming Responses** - See Claude's responses in real-time
- **Error Handling** - Clear error messages and guidance
- **Clean CLI Interface** - Simple and intuitive chat experience

## Authentication Comparison

| Feature | OAuth Token | API Key |
|---------|------------|---------|
| **Who** | Claude Pro/Max subscribers | Developers & enterprises |
| **Cost** | Uses subscription quota | Pay-per-use |
| **Setup** | `claude setup-token` | Get from console.anthropic.com |
| **Use Case** | Personal use, testing | Production applications |

## 📖 Complete Setup Guide

**For detailed setup instructions, troubleshooting, and lessons learned, see:**

👉 **[SETUP-GUIDE.md](./SETUP-GUIDE.md)** - Comprehensive guide with:
- Step-by-step OAuth token setup
- Common issues and solutions
- Token format requirements
- Security best practices
- Advanced configuration

## Troubleshooting

### "No authentication credentials found"

Make sure you have either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` set in your `.env` file.

### OAuth token expired

OAuth tokens expire after **1 year**. Run `claude setup-token` again to get a new token.

**Important:** Tokens must start with `sk-ant-`

### TypeScript compilation errors

Make sure you're using Node.js 18 or higher:

```bash
node --version  # Should be 18.0.0 or higher
```

### Module not found errors

Reinstall dependencies:

```bash
rm -rf node_modules package-lock.json
npm install
```

### More Issues?

See [SETUP-GUIDE.md](./SETUP-GUIDE.md) for comprehensive troubleshooting

## Scripts

- `npm run dev` - Run in development mode with auto-recompile (using tsx)
- `npm run build` - Compile TypeScript to JavaScript
- `npm start` - Build and run the compiled application
- `npm run clean` - Remove compiled output

## Learn More

- [Claude Agent SDK Documentation](https://docs.anthropic.com/en/docs/agents)
- [Anthropic API Documentation](https://docs.anthropic.com/)
- [Original Demo Repository](https://github.com/weidwonder/claude_agent_sdk_oauth_demo)

## License

MIT
