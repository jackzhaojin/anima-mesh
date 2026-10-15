---
name: task-researcher
description: Use the existing task-researcher agent workflow when the user requests investigation or implementation planning in the Claude subagent PoC.
---

# task-researcher

Read [the original agent](../../agents/task-researcher.md) in full before starting.
The role, workflow, output format, and restrictions live there. Keep that
file as the source; do not copy its body into this skill. If it is marked
generated, edit its declared upstream source and regenerate it.

Resolve the agent's project-relative paths from the project containing
`.claude/`, not from this skill folder. Use equivalent tools available in
the current session. Claude `model:` and `tools:` metadata do not configure
Codex; retain the session's model and permissions and honor the source's
restrictions. Report any missing capability before dependent work. If the
source cannot be read, report that the role is unavailable.

Use the role in the current conversation. When the user requests delegation,
pass the same source path and constraints to an available subagent. Loading
this skill does not itself authorize spawning agents or external actions.
