# Claude Agent SDK OAuth Setup Guide

Complete guide for setting up the Claude Agent SDK with OAuth token authentication (for Claude Pro/Max subscribers).

## Table of Contents
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Detailed Setup](#detailed-setup)
- [OAuth Token Details](#oauth-token-details)
- [Lessons Learned](#lessons-learned)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)
- [Usage Examples](#usage-examples)

---

## Prerequisites

Before you begin, ensure you have:

- ✅ **Node.js 18+** installed
- ✅ **Claude Pro or Claude Max subscription** (required for OAuth)
- ✅ **Terminal/Command Line** access

Check your Node.js version:
```bash
node --version  # Should be 18.0.0 or higher
```

---

## Quick Start

```bash
# 1. Install Claude CLI globally (if not already installed)
npm install -g @anthropic-ai/claude-code

# 2. Generate OAuth token (this opens a browser for authentication)
claude setup-token

# 3. Copy the generated token (starts with "sk-")
# The token will be displayed in your terminal

# 4. Navigate to your project
cd /path/to/your/agent-claude-sdk

# 5. Install dependencies
npm install

# 6. Create .env file and add your token
cp .env.example .env
# Edit .env and add: CLAUDE_CODE_OAUTH_TOKEN=sk-your-token-here

# 7. Run the demo
npm run dev
```

---

## Detailed Setup

### Step 1: Install Claude CLI

The Claude CLI is required to generate OAuth tokens:

```bash
npm install -g @anthropic-ai/claude-code
```

**Verify installation:**
```bash
claude --version
```

### Step 2: Generate OAuth Token

Run the setup-token command:

```bash
claude setup-token
```

**What happens:**
1. 🌐 Your browser opens automatically
2. 🔐 You authenticate with your Claude account
3. 📋 A token is generated and displayed in your terminal
4. ⏱️ Token is valid for **1 year** from generation date

**Important:** Copy the entire token immediately. It looks like:
```
sk-ant-...followed by many characters...
```

### Step 3: Configure Environment Variables

Create a `.env` file in your project root:

```bash
cp .env.example .env
```

Edit the `.env` file and add your token:

```env
# Authentication (OAuth Token for Claude Pro/Max subscribers)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-api03-your-actual-token-here

# Optional: Specify Claude model (defaults to claude-sonnet-4-5)
MODEL=claude-sonnet-4-5
```

**CRITICAL: Token Format Rules**
- ✅ DO: Start with `sk-ant-` prefix
- ✅ DO: Copy the ENTIRE token (can be very long)
- ✅ DO: Remove any quotes if present
- ❌ DON'T: Add extra spaces or line breaks
- ❌ DON'T: Include `#` characters outside the token
- ❌ DON'T: Wrap in quotes (unless required by your shell)

### Step 4: Install Project Dependencies

```bash
npm install
```

This installs:
- `@anthropic-ai/claude-agent-sdk` - The Claude Agent SDK
- `dotenv` - Environment variable management
- TypeScript and build tools

### Step 5: Test the Setup

Run the development version:

```bash
npm run dev
```

You should see:
```
🤖 Claude Agent SDK Chat Demo
══════════════════════════════════════════════════
Model: claude-sonnet-4-5
Auth: OAuth Token
══════════════════════════════════════════════════
Type your message and press Enter. Type "exit" or "quit" to end.

You:
```

---

## OAuth Token Details

### Token Characteristics

| Property | Value |
|----------|-------|
| **Prefix** | Always starts with `sk-ant-` |
| **Length** | Very long (100+ characters) |
| **Expiration** | 1 year from generation |
| **Source** | `claude setup-token` command |
| **Billing** | Uses Claude Pro/Max subscription quota |
| **Cost** | Fixed subscription cost, not pay-per-use |

### OAuth vs API Key

| Feature | OAuth Token (`CLAUDE_CODE_OAUTH_TOKEN`) | API Key (`ANTHROPIC_API_KEY`) |
|---------|----------------------------------------|-------------------------------|
| **Who** | Claude Pro/Max subscribers | Developers & enterprises |
| **Cost Model** | Fixed subscription | Pay-per-use |
| **Expiration** | 1 year | No expiration |
| **How to Get** | `claude setup-token` | console.anthropic.com |
| **Format** | Starts with `sk-ant-` | Starts with `sk-ant-` |
| **Renewal** | Run `claude setup-token` again | No renewal needed |

### Token Storage Location

The `claude setup-token` command also stores your token in:
```
~/.config/claude/settings.json
```

However, for the SDK to use it, you must also set it in your project's `.env` file.

---

## Lessons Learned

### 1. ⚠️ Token Format is Critical

**Problem:** Token contains special characters like `#`

**Solution:**
```env
# ❌ WRONG - Will be truncated at # character
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-abc123#def456

# ✅ CORRECT - No quotes, full token
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-abc123#def456ghi789
```

The `#` character in shell/env files starts a comment. Make sure your `.env` parser handles it correctly. The `dotenv` package handles this properly.

### 2. ⚠️ Token Must Start with `sk-ant-`

**Problem:** Token appears invalid

**Validation:**
```bash
# Check your token format
grep CLAUDE_CODE_OAUTH_TOKEN .env

# Should output something like:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-api03-...
```

If it doesn't start with `sk-ant-`, regenerate it:
```bash
claude setup-token
```

### 3. ⚠️ Quotes Can Cause Issues

**Problem:** Token wrapped in quotes

**Solution:**
```env
# ❌ WRONG - Quotes may be included as part of the token
CLAUDE_CODE_OAUTH_TOKEN="sk-ant-abc123..."

# ✅ CORRECT - No quotes
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-abc123...
```

### 4. ⚠️ Token Expiration After 1 Year

**Problem:** After 1 year, authentication fails with "Invalid bearer token"

**Solution:**
```bash
# Simply regenerate a new token
claude setup-token

# Update your .env file with the new token
```

**Pro tip:** Set a calendar reminder for 11 months from now to regenerate your token before it expires.

### 5. ⚠️ Environment Variables Must Be Loaded

**Problem:** SDK can't find the token

**Solution:** Ensure `dotenv` is configured at the top of your entry file:

```typescript
import { config } from 'dotenv';

// Load environment variables FIRST, before any other imports
config();
```

### 6. ⚠️ Different Behavior: CLI vs SDK

**Understanding:**
- **Claude CLI** (`claude` command): Reads token from `~/.config/claude/settings.json`
- **Claude Agent SDK**: Reads token from environment variables (`process.env.CLAUDE_CODE_OAUTH_TOKEN`)

**Important:** You need the token in BOTH places for full functionality.

---

## Troubleshooting

### Error: "Invalid bearer token"

**Symptoms:**
```
API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}
```

**Solutions:**
1. Check token format (must start with `sk-ant-`)
2. Ensure no extra spaces or characters
3. Verify token hasn't expired (1 year limit)
4. Regenerate token: `claude setup-token`

### Error: "No authentication credentials found"

**Symptoms:**
```
❌ Error: No authentication credentials found!
```

**Solutions:**
1. Verify `.env` file exists
2. Check `CLAUDE_CODE_OAUTH_TOKEN` is set correctly
3. Ensure `dotenv` is loaded: `config()` at the top of your file

### Error: "Claude Code process exited with code 1"

**Symptoms:**
```
Error: Claude Code process exited with code 1
```

**Solutions:**
1. Check Node.js version (must be 18+)
2. Reinstall dependencies: `rm -rf node_modules && npm install`
3. Verify `.env` file is in the correct directory
4. Try regenerating OAuth token

### Error: "command not found: claude"

**Symptoms:**
```
bash: claude: command not found
```

**Solutions:**
1. Install Claude CLI: `npm install -g @anthropic-ai/claude-code`
2. Verify installation: `claude --version`
3. Check npm global bin directory is in PATH:
   ```bash
   npm config get prefix
   # Should be in your PATH
   ```

### Token Appears Truncated

**Symptoms:**
Token seems incomplete or ends early

**Solutions:**
1. Check for `#` characters being interpreted as comments
2. Ensure you copied the ENTIRE token from `claude setup-token`
3. Verify no line breaks in the token value
4. Check `.env` file encoding (should be UTF-8)

### TypeScript Compilation Errors

**Symptoms:**
```
error TS2345: Argument of type '...' is not assignable to parameter of type '...'
```

**Solutions:**
1. Ensure TypeScript version matches: `npm install`
2. Check `tsconfig.json` is properly configured
3. Verify SDK types are installed: `npm list @anthropic-ai/claude-agent-sdk`

---

## Project Structure

```
agent-claude-sdk/
├── src/
│   └── index.ts              # Main application (TypeScript)
├── dist/                     # Compiled JavaScript (generated by tsc)
│   ├── index.js
│   ├── index.js.map
│   ├── index.d.ts
│   └── index.d.ts.map
├── node_modules/             # Dependencies (generated by npm install)
├── .env                      # Environment variables (YOU CREATE THIS)
├── .env.example              # Template for .env
├── .gitignore               # Git ignore rules
├── package.json             # Project dependencies and scripts
├── package-lock.json        # Dependency lock file
├── tsconfig.json            # TypeScript configuration
├── README.md                # Project documentation
└── SETUP-GUIDE.md          # This file
```

---

## Usage Examples

### Example 1: Basic Chat

```bash
npm run dev
```

```
You: What is 2+2?

Claude: 2+2 equals 4.
```

### Example 2: Code Help

```
You: Explain TypeScript generics in one sentence

Claude: TypeScript generics allow you to write reusable code components that work with multiple types while maintaining type safety through type parameters.
```

### Example 3: Multi-turn Conversation

The SDK supports streaming and multi-turn conversations. Modify `maxTurns` in `src/index.ts`:

```typescript
const stream = query({
  prompt: userMessage,
  options: {
    model,
    maxTurns: 5  // Allow up to 5 back-and-forth exchanges
  }
});
```

### Example 4: Check Usage Stats

After each response, you can track token usage and costs. See the result message in the stream:

```typescript
for await (const message of stream) {
  if (message.type === 'result' && message.subtype === 'success') {
    console.log('Input tokens:', message.usage.input_tokens);
    console.log('Output tokens:', message.usage.output_tokens);
    console.log('Cost:', message.total_cost_usd);
  }
}
```

---

## Scripts Reference

| Script | Command | Description |
|--------|---------|-------------|
| **dev** | `npm run dev` | Run in development mode (auto-compiles TypeScript) |
| **build** | `npm run build` | Compile TypeScript to JavaScript |
| **start** | `npm start` | Build and run the compiled application |
| **clean** | `npm run clean` | Remove compiled output (`dist/` folder) |

---

## Security Best Practices

### 1. Never Commit Your `.env` File

Your `.gitignore` should include:
```gitignore
.env
.env.local
```

### 2. Token Rotation

Regenerate your OAuth token:
- ⏰ Every 11 months (before 1-year expiration)
- 🔒 If you suspect it's been compromised
- 🔄 When changing accounts

### 3. Environment-Specific Tokens

For different environments:
```bash
# Development
.env.development

# Production
.env.production

# Load the right one
npm run dev          # Uses .env.development
npm run prod         # Uses .env.production
```

---

## Advanced Configuration

### Custom Model Selection

```env
# Use Claude Opus instead of Sonnet
MODEL=claude-opus-4-5

# Use Claude Haiku for faster, cheaper responses
MODEL=claude-haiku-3-5
```

### Timeout Configuration

Modify the query options:

```typescript
const stream = query({
  prompt: userMessage,
  options: {
    model,
    maxTurns: 1,
    maxBudgetUsd: 1.00,  // Stop if cost exceeds $1
    maxThinkingTokens: 10000  // Limit thinking tokens
  }
});
```

### Enable Debug Logging

```typescript
const stream = query({
  prompt: userMessage,
  options: {
    model,
    maxTurns: 1,
    includePartialMessages: true  // See streaming events
  }
});
```

---

## Getting Help

If you encounter issues not covered here:

1. **Check the official docs**: https://docs.anthropic.com/
2. **Agent SDK GitHub**: https://github.com/anthropics/claude-agent-sdk-typescript
3. **Community discussions**: https://github.com/anthropics/claude-code/discussions
4. **Regenerate your token**: Often solves authentication issues

---

## Important Reminders

- 📅 **OAuth tokens expire after 1 year**
- 🔑 **Token format**: Must start with `sk-ant-`
- 💰 **Billing**: Uses your Claude Pro/Max subscription, not pay-per-use
- 🔄 **Renewal**: Run `claude setup-token` to get a new token
- 🔒 **Security**: Never commit `.env` files to version control
- ⚙️ **Node version**: Requires Node.js 18 or higher

---

## Success Checklist

Before considering your setup complete:

- [ ] Claude CLI installed (`claude --version` works)
- [ ] OAuth token generated (`claude setup-token` completed)
- [ ] Token starts with `sk-ant-`
- [ ] `.env` file created with `CLAUDE_CODE_OAUTH_TOKEN`
- [ ] Dependencies installed (`npm install` succeeded)
- [ ] TypeScript compiles (`npm run build` succeeds)
- [ ] Demo runs (`npm run dev` starts without errors)
- [ ] Authentication works (successfully sends a test message)
- [ ] Set calendar reminder for token renewal in 11 months

---

## License

MIT

---

**Last Updated:** December 11, 2024

**Working Implementation**: This guide is based on a successfully working implementation tested with Claude Pro subscription and OAuth token authentication.
