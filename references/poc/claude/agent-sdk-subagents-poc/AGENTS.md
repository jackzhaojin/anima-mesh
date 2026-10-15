# AGENTS.md

Read [CLAUDE.md](CLAUDE.md) for this PoC's local instructions, in addition
to the repository root's guidance. Claude is the primary assistant;
maintain shared instructions in `CLAUDE.md`.

The Claude SDK tools and agent configuration described there belong to the
PoC being studied. Use Codex's available tools for your own session.

Launch Codex here to discover `$code-validator` and `$task-researcher`.
These shared skills read the originals in `.claude/agents/`; maintain the
role bodies there. `.agents/skills` links to `.claude/skills/`. The role
can run in the current chat; delegate only when the user requests it.
