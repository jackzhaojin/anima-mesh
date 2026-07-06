# Agent SDK Subagents POC - Findings

**Date:** 2026-01-25
**Status:** VALIDATED ✅
**Test Results:** 4/4 core tests passed + user-level agent invocation confirmed

## Executive Summary

The Claude Agent SDK fully supports subagent delegation via the `Task` tool. Both user-level agents (`~/.claude/agents/`) and project-level agents (`.claude/agents/`) are discovered and invocable when properly configured.

## Critical Configuration

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const stream = query({
  prompt: "Your task here",
  options: {
    cwd: "/path/to/project",              // Required for project agents
    settingSources: ['user', 'project'],  // REQUIRED to load agents from filesystem
    allowedTools: ['Task', ...]           // Task tool enables subagent delegation
  }
});
```

### Required Settings

| Setting | Value | Purpose |
|---------|-------|---------|
| `settingSources` | `['user', 'project']` | **REQUIRED** - Loads agents from filesystem |
| `allowedTools` | Must include `'Task'` | Enables subagent delegation |
| `cwd` | Project root path | Enables project-level agent discovery |

### Missing Any Setting = Subagents Won't Work

- No `settingSources` → No agents loaded from filesystem
- No `'Task'` in `allowedTools` → Can't delegate to subagents
- Wrong/missing `cwd` → Project agents not found

## Agent Definition Format

Subagents are markdown files with YAML frontmatter in `.claude/agents/`:

```markdown
---
name: my-agent
description: When Claude should use this agent...
tools: Read, Grep, Glob, Bash
model: haiku
---

System prompt in markdown body.
```

### Required Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier (lowercase, hyphens) |
| `description` | Yes | When Claude should delegate to this agent |
| `tools` | No | Allowlist of tools (inherits all if omitted) |
| `model` | No | `sonnet`, `opus`, `haiku`, or `inherit` |
| `permissionMode` | No | `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `plan` |
| `skills` | No | Skills to preload into agent context |
| `hooks` | No | Lifecycle hooks (PreToolUse, PostToolUse, Stop) |

## Agent Locations (Priority Order)

| Location | Scope | Priority |
|----------|-------|----------|
| `--agents` CLI flag | Session only | 1 (highest) |
| `.claude/agents/` | Project | 2 |
| `~/.claude/agents/` | User (all projects) | 3 |
| Plugin agents | Where plugin enabled | 4 (lowest) |

When multiple agents share the same name, higher priority wins.

## Built-in Subagents

Always available without configuration:

| Agent | Model | Purpose |
|-------|-------|---------|
| **Explore** | Haiku | Fast, read-only codebase exploration |
| **Plan** | Inherits | Research for plan mode |
| **general-purpose** | Inherits | Complex multi-step tasks |
| **Bash** | Inherits | Terminal command execution |

## Test Results

### Core Tests (4/4 Passed)

```
✅ PASS: Task tool availability (18017ms)
✅ PASS: Custom subagent invocation - task-researcher (27027ms)
✅ PASS: Built-in Explore subagent (34074ms)
✅ PASS: Subagent context isolation (45224ms)
```

### User-Level Agent Test

```
✅ Agent discovered: jack-web-build-and-test-v1 from ~/.claude/agents/
✅ Agent invoked successfully
✅ Agent created output file (hello.html)
⏱️  Duration: 32609ms
```

## Key Learnings

### 1. Subagents vs Skills

| Aspect | Skills | Subagents |
|--------|--------|-----------|
| Location | `.claude/skills/` | `.claude/agents/` |
| Tool | `Skill` | `Task` |
| Context | Runs in main context | Isolated context |
| Purpose | Reusable prompts/workflows | Delegated autonomous tasks |
| Nesting | Can be invoked by subagents | Cannot spawn other subagents |

### 2. Context Isolation

- Each subagent gets its own context window
- Only results return to main conversation (not full context)
- Useful for high-volume operations (test runs, log processing)
- Prevents context pollution in main conversation

### 3. Subagent Limitations

- **Cannot spawn other subagents** (no nested delegation)
- Background subagents auto-deny permissions not pre-approved
- MCP tools not available in background subagents
- Resumed subagents retain full conversation history

### 4. When to Use Subagents

**Use subagents when:**
- Task produces verbose output you don't need in main context
- Want to enforce specific tool restrictions
- Work is self-contained and can return a summary
- Running parallel research/analysis

**Use main conversation when:**
- Task needs frequent back-and-forth
- Multiple phases share significant context
- Making quick, targeted changes
- Latency matters (subagents start fresh)

### 5. Invoking Subagents

Claude automatically delegates based on:
- Task description matching agent's `description` field
- Current context requirements
- Include "use proactively" in description for automatic delegation

Explicit invocation:
```
Use the task-researcher subagent to analyze this project
Have Explore find all TypeScript files
```

## Comparison with Skills POC

| Capability | Skills POC | Subagents POC |
|------------|------------|---------------|
| Tool required | `Skill` | `Task` |
| File location | `.claude/skills/` | `.claude/agents/` |
| File format | `SKILL.md` with frontmatter | `*.md` with frontmatter |
| Context behavior | Injected into main | Isolated context |
| Can specify model | No | Yes (`model` field) |
| Can restrict tools | No | Yes (`tools` field) |
| Can set permissions | No | Yes (`permissionMode`) |

## Recommendations for Continuous Agent

1. **Use subagents for isolated tasks** - Research, validation, exploration
2. **Create project-specific agents** in `.claude/agents/` for common workflows
3. **Leverage user-level agents** for cross-project capabilities (like `jack-web-build-and-test-v1`)
4. **Use Haiku model** for lightweight agents to reduce latency and cost
5. **Write clear descriptions** so Claude knows when to delegate automatically
6. **Consider context management** - subagents prevent main context bloat

## Files Created

```
agent-sdk-subagents-poc/
├── .claude/agents/
│   ├── task-researcher.md      # Research specialist (haiku)
│   └── code-validator.md       # Validation specialist (haiku)
├── src/
│   ├── index.ts                # Interactive CLI
│   └── experiments/
│       ├── test-subagents.ts   # Core test suite
│       ├── test-user-agent.ts  # User-level agent discovery
│       └── test-invoke-build-agent.ts  # Invocation test
├── test-results/               # Generated test results
├── test-output/                # Generated test outputs
│   └── hello.html              # Created by subagent
├── CLAUDE.md
├── FINDINGS.md                 # This file
└── package.json
```

## References

- [Claude Code Subagents Docs](https://code.claude.com/docs/en/sub-agents)
- [Anthropic Engineering Blog](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [Agent SDK NPM Package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
