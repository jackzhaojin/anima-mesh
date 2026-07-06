# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A CLI chat interface demonstrating the Claude Agent SDK with OAuth token authentication. Single-file TypeScript application that provides an interactive command-line chat with Claude using the `@anthropic-ai/claude-agent-sdk`.

## Development Commands

```bash
# Development mode (auto-recompile with tsx)
npm run dev

# Production build
npm run build
npm start

# Clean compiled output
npm run clean
```

## Architecture

**Single Entry Point**: `src/index.ts` contains the entire application.

**Key Flow**:
1. Load environment variables with `dotenv.config()`
2. Validate authentication (OAuth token OR API key)
3. Create readline interface for CLI input
4. Use `query()` from Agent SDK with streaming responses
5. Process streaming messages and display results

**Authentication Priority**:
- Checks `CLAUDE_CODE_OAUTH_TOKEN` first (OAuth for Claude Pro/Max)
- Falls back to `ANTHROPIC_API_KEY` (pay-per-use API)
- Exits if neither is found

**SDK Integration**:
- Uses `query()` function (not the Client class)
- Streams responses using async iteration
- Handles `SDKResultMessage` types for success/error states
- Configured with `maxTurns: 1` (single-turn conversations)

## Environment Configuration

**Required** (one of):
- `CLAUDE_CODE_OAUTH_TOKEN` - OAuth token from `claude setup-token` (must start with `sk-ant-`)
- `ANTHROPIC_API_KEY` - API key from console.anthropic.com

**Optional**:
- `MODEL` - Defaults to `claude-opus-4-5`

**Critical Token Format**:
- Must start with `sk-ant-` prefix
- No quotes around the token value in `.env`
- The `#` character in tokens is valid (not a comment marker when using dotenv)
- Token expires after 1 year

## TypeScript Configuration

**Target**: ES2022 with ES modules (`"type": "module"` in package.json)

**Output**: Compiles `src/` to `dist/` with:
- Source maps (`.js.map`)
- Type declarations (`.d.ts`)
- Declaration maps (`.d.ts.map`)

**Strict Mode**: Full TypeScript strict checking enabled

## Key Dependencies

- `@anthropic-ai/claude-agent-sdk` - Core SDK for Claude interaction
- `dotenv` - Environment variable loading
- `tsx` - Development mode TypeScript execution
- `readline` - Built-in Node.js module for CLI interaction

## Common Issues

**Authentication Errors**:
- Verify token format starts with `sk-ant-`
- Check token hasn't expired (1 year from generation)
- Ensure `.env` file exists and dotenv loads before SDK usage
- Regenerate token: `claude setup-token`

**TypeScript Errors**:
- Requires Node.js 18+ (`"engines": { "node": ">=18.0.0" }`)
- If module errors occur, verify `"type": "module"` in package.json

**Runtime Behavior**:
- The CLI waits for user input with readline prompt
- Type "exit" or "quit" to end the session
- Empty messages are skipped
- Errors show user-friendly guidance pointing to authentication docs

## Development Notes

**Single Responsibility**: This is intentionally a minimal example. Don't add features like:
- Conversation history/memory
- Multi-turn conversations (currently maxTurns: 1)
- Tool use or function calling
- Complex error recovery

**SDK Usage Pattern**:
```typescript
const stream = query({
  prompt: userMessage,
  options: {
    model,
    maxTurns: 1
  }
});

for await (const message of stream) {
  // Handle streaming messages
}
```

**Authentication Detection**:
The SDK automatically detects and uses environment variables. No explicit credential passing needed in the `query()` call.

## File Locations

- Source: `src/index.ts` (single file)
- Compiled: `dist/index.js` (entry point)
- Config: `.env` (not committed), `.env.example` (template)
- Docs: `README.md`, `SETUP-GUIDE.md`, `QUICK-REFERENCE.md`
