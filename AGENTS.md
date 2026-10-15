# AGENTS.md

Read [CLAUDE.md](CLAUDE.md) in full before working in this repository.
Claude remains the primary assistant; `CLAUDE.md` is the canonical working
agreement for both Claude and Codex. Maintain shared rules there; this file
is Codex's entry point.

Repo skills are shared through `.agents/skills -> ../.claude/skills`.
Edit the originals in `.claude/skills/`, and read the relevant `SKILL.md`
before using a skill. See CLAUDE.md's **Claude and Codex** section for the
boundaries between shared guidance and tool-specific configuration.

Before working in a nested directory, read its applicable `AGENTS.md` and
`CLAUDE.md` too. PoC instructions describe that PoC; they do not override
the public engine's privacy rule or make it production code.
