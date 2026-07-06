# Agent SDK Skills POC - Findings Document

**Status**: COMPLETE
**Last Updated**: 2025-01-24
**Author**: Claude (assisted by jackjin)

---

## Executive Summary

**Skills work with the Claude Agent SDK.** Both user-level skills (`~/.claude/skills/`) and project-level bundled skills (`.claude/skills/`) are fully functional when properly configured.

### Key Configuration Requirements

```typescript
const stream = query({
  prompt: "...",
  options: {
    cwd: "/path/to/project",              // Where .claude/skills/ is located
    settingSources: ['user', 'project'],  // REQUIRED to load skills
    allowedTools: ['Skill', ...]          // Must include 'Skill'
  }
});
```

### What Works

| Feature | Status | Notes |
|---------|--------|-------|
| User skills (~/.claude/skills/) | ✅ WORKS | Loaded when settingSources includes "user" |
| Project skills (.claude/skills/) | ✅ WORKS | Loaded when settingSources includes "project" |
| Bundled skills with agent | ✅ WORKS | Place in project's .claude/skills/ |
| Skill discovery | ✅ WORKS | Skills appear in slash_commands in init message |
| Skill invocation | ✅ WORKS | Use Skill tool with skill name |
| SKILL.md loading | ✅ WORKS | Content injected as synthetic user message |

---

## Proven Configuration

### Minimal Working Example

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const stream = query({
  prompt: "Use the my-skill skill",
  options: {
    cwd: process.cwd(),                   // Project root with .claude/skills/
    settingSources: ['user', 'project'],  // REQUIRED!
    allowedTools: ['Skill', 'Read', 'Bash', 'Write']  // 'Skill' is required
  }
});
```

### What Each Option Does

| Option | Purpose | Required? |
|--------|---------|-----------|
| `cwd` | Where to find .claude/skills/ for project skills | Yes, for project skills |
| `settingSources` | Which skill locations to load | **YES** - without this, no skills load |
| `allowedTools` with 'Skill' | Enables the Skill tool | **YES** - without this, can't invoke skills |

---

## Experiment Results

### Experiment 1: No Configuration (Baseline)
- **Config**: No settingSources, no Skill in allowedTools
- **Result**: Claude mentions Skill tool exists but reports "no skills available"
- **Conclusion**: Baseline confirmed - skills require explicit configuration

### Experiment 2: settingSources Only
- **Config**: settingSources: ['user', 'project'], NO Skill in allowedTools
- **Result**: Claude can LIST skills but cannot invoke them
- **Conclusion**: Skills are discovered but not invocable without 'Skill' tool

### Experiment 3: Skill Tool Only
- **Config**: Skill in allowedTools, NO settingSources
- **Result**: Claude reports "no skills available"
- **Conclusion**: **settingSources is REQUIRED** for skill discovery

### Experiment 4: Full Configuration
- **Config**: settingSources: ['user', 'project'], Skill in allowedTools
- **Result**: All skills listed (8 user + 1 project = 9 total)
- **Conclusion**: Full configuration enables complete skill functionality

### Experiment 5: User Skills Only
- **Config**: settingSources: ['user']
- **Result**: Only user skills (8) listed, NOT poc-test-skill
- **Conclusion**: Can selectively load skill sources

### Experiment 6: Project Skills Only
- **Config**: settingSources: ['project']
- **Result**: Only poc-test-skill listed (1 skill)
- **Conclusion**: Project skills work in isolation

### Experiment 7: Trigger Bundled Project Skill
- **Prompt**: "poc test - demonstrate skills"
- **Result**: ✅ SUCCESS - Skill invoked, SKILL.md loaded, Claude followed instructions
- **Conclusion**: **Bundled project skills work!**

### Experiment 8: Trigger User Skill
- **Prompt**: "log this session"
- **Result**: ✅ SUCCESS - conversation-logger skill invoked and Claude started following instructions
- **Conclusion**: **User skills work!**

### Experiment 9: Wrong CWD
- **Config**: cwd: '/tmp' (no .claude/skills/)
- **Result**: poc-test-skill NOT available, only user skills loaded
- **Conclusion**: **cwd determines project skill location**

### Experiment 10: No CWD
- **Config**: No cwd specified
- **Result**: All skills loaded (SDK uses process.cwd())
- **Conclusion**: SDK defaults to process.cwd() for project skills

---

## How Skills Work Internally

Based on debug analysis, here's the complete skill invocation flow:

### 1. Initialization
```
SDK sends init message with:
- tools: [..., "Skill", ...]
- slash_commands: ["skill1", "skill2", ...]  <-- Skills discovered!
```

### 2. Skill Invocation
```
Claude calls: Skill tool with {"skill": "skill-name"}
SDK returns: "Launching skill: skill-name" with success=true
```

### 3. Skill Content Injection
```
SDK injects synthetic user message with:
- "Base directory for this skill: /path/to/skill"
- Full SKILL.md content
```

### 4. Claude Follows Instructions
```
Claude reads the injected SKILL.md and follows its instructions
```

---

## SKILL.md Format

```yaml
---
name: my-skill
description: When to use this skill. Include trigger phrases like "do X" or "help with Y".
version: 1.0.0
---

# My Skill

Instructions for Claude when this skill is invoked.

## When This Applies

- Trigger phrase 1
- Trigger phrase 2

## What To Do

1. Step one
2. Step two
```

### Field Requirements

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | Max 64 chars, lowercase + hyphens |
| `description` | Yes | Max 1024 chars, include trigger phrases |
| `version` | No | Semantic version |

---

## Skill Locations

### User Skills: `~/.claude/skills/`
- Personal skills across all projects
- Loaded when settingSources includes "user"
- Your location: symlink to `/Users/jackjin/dev/jack-dev-server-configs/local/claude-settings/skills`

Your user skills:
- claude-mcp-builder
- claude-pdf
- claude-skill-creator
- conversation-logger
- harness-build
- harness-research
- harness-spec
- harness-validate

### Project Skills: `.claude/skills/` (relative to cwd)
- Per-project skills bundled with the codebase
- Loaded when settingSources includes "project"
- Can be committed to git and shared with team

Created for this POC:
- poc-test-skill

---

## Bundling Skills with Your Agent

**YES, you can bundle skills with your agent!**

### Directory Structure

```
your-agent/
├── .claude/
│   └── skills/
│       └── your-skill/
│           └── SKILL.md
├── src/
│   └── index.ts
└── package.json
```

### Configuration

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = dirname(dirname(__filename));

const stream = query({
  prompt: userInput,
  options: {
    cwd: PROJECT_ROOT,  // Point to directory containing .claude/skills/
    settingSources: ['project'],  // Only project skills (or ['user', 'project'])
    allowedTools: ['Skill', 'Read', 'Bash']
  }
});
```

---

## Common Mistakes

### 1. Forgetting settingSources

```typescript
// ❌ WRONG - Skills won't load
query({
  prompt: "...",
  options: {
    allowedTools: ['Skill']
  }
});

// ✅ CORRECT
query({
  prompt: "...",
  options: {
    settingSources: ['user', 'project'],  // REQUIRED!
    allowedTools: ['Skill']
  }
});
```

### 2. Forgetting 'Skill' in allowedTools

```typescript
// ❌ WRONG - Can see skills but can't invoke
query({
  prompt: "...",
  options: {
    settingSources: ['user', 'project'],
    allowedTools: ['Read', 'Bash']  // Missing 'Skill'!
  }
});

// ✅ CORRECT
query({
  prompt: "...",
  options: {
    settingSources: ['user', 'project'],
    allowedTools: ['Skill', 'Read', 'Bash']
  }
});
```

### 3. Wrong cwd for Project Skills

```typescript
// ❌ WRONG - Project skills not found
query({
  prompt: "...",
  options: {
    cwd: '/wrong/path',
    settingSources: ['project'],
    allowedTools: ['Skill']
  }
});

// ✅ CORRECT
query({
  prompt: "...",
  options: {
    cwd: '/path/to/project/with/.claude/skills/',
    settingSources: ['project'],
    allowedTools: ['Skill']
  }
});
```

---

## Recommendations

### For Agent Developers

1. **Always include settingSources** - Default should be `['user', 'project']`
2. **Always include 'Skill' in allowedTools** - Enable skill invocation
3. **Set cwd to project root** - For bundled skills to work
4. **Use maxTurns >= 5** - Skills may need multiple turns to complete

### For Skill Authors

1. **Write clear descriptions** - Include trigger phrases
2. **Keep skills focused** - One skill = one capability
3. **Test your skills** - Verify they trigger correctly
4. **Bundle with projects** - Use .claude/skills/ for project-specific skills

---

## Documentation Sources

- [Agent SDK Skills](https://platform.claude.com/docs/en/agent-sdk/skills)
- [Agent Skills Overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Agent Skills Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [NPM Package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

---

## Project Structure

```
agent-sdk-skills-poc/
├── .claude/
│   └── skills/
│       └── poc-test-skill/
│           └── SKILL.md          # Test skill proving bundling works
├── src/
│   ├── index.ts                  # Interactive CLI with skills
│   └── experiments/
│       ├── run-all-tests.ts      # Comprehensive test suite
│       └── debug-skill-invocation.ts  # Detailed debug output
├── test-results/                 # Generated test results
├── FINDINGS.md                   # This document
├── package.json
├── tsconfig.json
└── .env
```

---

## Conclusion

**Skills fully work with the Claude Agent SDK when properly configured.**

The key requirements are:
1. `settingSources: ['user', 'project']` - to load skills from filesystem
2. `'Skill'` in `allowedTools` - to enable skill invocation
3. `cwd` pointing to project root - for project-bundled skills

Skills can be bundled with agents by placing them in the project's `.claude/skills/` directory. This allows agent developers to ship specialized capabilities alongside their agents.

---

## Extended Tests: Script Execution & Real Workflows

### Test 1: Project Analyzer (Script Execution)

**Goal**: Verify skills can bundle and execute scripts

**Result**: ✅ SUCCESS

**What Happened**:
1. Claude invoked `Skill` tool with `project-analyzer`
2. Claude ran the bundled `scripts/analyze.js` via Bash
3. Script analyzed project and output structured data
4. Claude formatted results for user

**Tools Used**: Skill → Bash → Read → Edit

**Key Finding**: **Scripts bundled with skills work!** The skill can reference and execute scripts in its directory.

### Test 2: Conversation Logger (User Skill)

**Goal**: Verify user skills (~/.claude/skills/) work and create real files

**Result**: ✅ SUCCESS

**What Happened**:
- Claude created `prompt-log.md` with properly formatted session log
- File created in project root as expected

**Output File Created**:
```markdown
# Conversation Log
**Session Date**: 2025-01-24

## Prompt 1
**User**: Testing the conversation logger skill
**Assistant**: Successfully tested
```

### Test 3: Skill Discovery

**Goal**: Verify Claude can discover project-specific skills

**Result**: ✅ SUCCESS

**Skills Found**:
1. `poc-test-skill` - Test skill for POC validation
2. `project-analyzer` - Script-based project analysis

---

## Extended Test Commands

```bash
# Run extended tests (script execution + real file creation)
npm run test:extended

# Run original 10-experiment suite
npm run test:all

# Interactive testing
npm run dev
```

---

*This POC successfully validates that Agent SDK skills work as documented.*
