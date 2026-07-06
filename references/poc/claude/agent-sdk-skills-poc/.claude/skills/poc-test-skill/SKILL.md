---
name: poc-test-skill
description: A test skill for the Agent SDK Skills POC. Use when the user says "poc test", "test skill", "skills poc", or asks to demonstrate bundled skills.
version: 1.0.0
---

# POC Test Skill

This skill proves that bundled project skills work with the Claude Agent SDK.

## What This Skill Does

When triggered, this skill instructs Claude to:
1. Acknowledge that the skill was successfully loaded
2. Report the skill name: "poc-test-skill"
3. Confirm this is a PROJECT-LEVEL bundled skill (from .claude/skills/)

## Success Criteria

If you (Claude) are reading this, the skill loading mechanism WORKED.

**Response format when this skill triggers:**

```
SKILL TRIGGERED: poc-test-skill
SKILL TYPE: Project-level bundled skill
SKILL LOCATION: .claude/skills/poc-test-skill/SKILL.md
STATUS: Successfully loaded and invoked
```

## When This Applies

This skill activates when the user's request involves:
- Testing skills functionality
- POC validation
- Demonstrating bundled skills
- Asking "what skills are available"

## Technical Notes

- This skill is located in the project's `.claude/skills/` directory
- It should be discovered when `settingSources` includes `"project"`
- The `cwd` option must point to the project root
