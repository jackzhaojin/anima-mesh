# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A proof-of-concept demonstrating Claude Agent SDK subagent capabilities via the Task tool. This validates that agents can delegate work to specialized subagents with their own tools, models, and context.

## Key Configuration

**Subagents require this configuration:**

```typescript
query({
  prompt: "...",
  options: {
    cwd: "/path/to/project",              // For .claude/agents/
    settingSources: ['user', 'project'],  // REQUIRED to load agents
    allowedTools: ['Task', ...]           // Task enables subagent delegation!
  }
});
```

## Development Commands

```bash
# Interactive CLI with subagent support
npm run dev

# Run subagent test suite
npm run test:subagents

# Build for production
npm run build
```

## Project Structure

```
agent-sdk-subagents-poc/
├── .claude/
│   └── agents/
│       ├── task-researcher.md    # Custom research subagent
│       └── code-validator.md     # Custom validation subagent
├── src/
│   ├── index.ts                  # Interactive CLI
│   └── experiments/
│       └── test-subagents.ts     # Automated test suite
├── test-results/                 # Generated test results
└── package.json
```

## Subagent Locations

- **Project agents**: `.claude/agents/` relative to `cwd`
- **User agents**: `~/.claude/agents/` (global)
- **Built-in**: Explore, Plan, general-purpose (always available)

## Subagent Definition Format

Markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: When to use this agent...
tools: Read, Grep, Glob, Bash
model: haiku
---

System prompt goes here in the markdown body.
```

## Key Differences from Skills

| Aspect | Skills | Subagents |
|--------|--------|-----------|
| Location | `.claude/skills/` | `.claude/agents/` |
| Tool | `Skill` | `Task` |
| Context | Runs in main context | Isolated context |
| Purpose | Reusable prompts/workflows | Delegated autonomous tasks |

## Testing Subagents

```
# Direct invocation
"Use the task-researcher subagent to analyze this project"

# Built-in subagents
"Have Explore find all TypeScript files"
"Use general-purpose to implement a feature"
```

## Environment Configuration

**Required** (one of):
- `CLAUDE_CODE_OAUTH_TOKEN` - OAuth token from `claude setup-token`
- `ANTHROPIC_API_KEY` - API key from console.anthropic.com

## Common Issues

### Subagents Not Found
**Cause**: Missing `settingSources`
**Fix**: Add `settingSources: ['user', 'project']` to options

### Can't Delegate Tasks
**Cause**: 'Task' not in allowedTools
**Fix**: Add 'Task' to your allowedTools array

### Custom Agents Not Loading
**Cause**: Wrong or missing `cwd`
**Fix**: Set `cwd` to directory containing `.claude/agents/`
