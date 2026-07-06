# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A proof-of-concept demonstrating how the Claude Agent SDK discovers, loads, and invokes Skills. This project conclusively validates that skills work and documents the exact configuration required.

## Key Findings

**Skills WORK with the Agent SDK.** The required configuration is:

```typescript
query({
  prompt: "...",
  options: {
    cwd: "/path/to/project",              // For .claude/skills/
    settingSources: ['user', 'project'],  // REQUIRED!
    allowedTools: ['Skill', ...]          // Must include 'Skill'
  }
});
```

See `FINDINGS.md` for complete documentation of all experiments and results.

## Development Commands

```bash
# Interactive CLI with skills support
npm run dev

# Run comprehensive test suite
npm run test:all

# Individual experiment tests
npx tsx src/experiments/debug-skill-invocation.ts
```

## Project Structure

```
agent-sdk-skills-poc/
├── .claude/
│   └── skills/
│       └── poc-test-skill/    # Bundled project skill (proof of concept)
│           └── SKILL.md
├── src/
│   ├── index.ts               # Interactive CLI with full skill support
│   └── experiments/
│       ├── run-all-tests.ts   # 10-experiment test suite
│       └── debug-skill-invocation.ts  # Detailed message-level debug
├── test-results/              # Generated test result files
├── FINDINGS.md                # Complete documentation of what works
└── package.json
```

## Critical Configuration

### settingSources is REQUIRED

Without `settingSources`, no skills are loaded from the filesystem:

```typescript
// ❌ WRONG - Skills won't load
query({ options: { allowedTools: ['Skill'] } });

// ✅ CORRECT
query({ options: { settingSources: ['user', 'project'], allowedTools: ['Skill'] } });
```

### Skill Locations

- **User skills**: `~/.claude/skills/` (loaded with `settingSources: ['user']`)
- **Project skills**: `.claude/skills/` relative to `cwd` (loaded with `settingSources: ['project']`)

## Environment Configuration

**Required** (one of):
- `CLAUDE_CODE_OAUTH_TOKEN` - OAuth token from `claude setup-token`
- `ANTHROPIC_API_KEY` - API key from console.anthropic.com

## Key Files

- `FINDINGS.md` - Complete POC results and recommendations
- `src/index.ts` - Working example of skills-enabled agent
- `.claude/skills/poc-test-skill/SKILL.md` - Example bundled skill

## Testing Skills

Ask Claude:
- "What skills are available?" - Lists all discovered skills
- "poc test" - Triggers the bundled poc-test-skill
- "log this session" - Triggers user conversation-logger skill

## Common Issues

### Skills Not Found
**Cause**: Missing `settingSources`
**Fix**: Add `settingSources: ['user', 'project']` to options

### Can't Invoke Skills
**Cause**: 'Skill' not in allowedTools
**Fix**: Add 'Skill' to your allowedTools array

### Project Skills Missing
**Cause**: Wrong or missing `cwd`
**Fix**: Set `cwd` to directory containing `.claude/skills/`
