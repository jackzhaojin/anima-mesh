# Local mode: a brain that never leaves the machine

Some brains hold knowledge that belongs to someone else: an employer's
work, a client's material, anything proprietary. For those, AnimaMesh has a
local mode (v2.3.6). You get the same practices (OKF memory, the focus file,
the two-tier layout, the newest-first log, gated agents) with every
integration switched off in code.

```bash
pnpm cli init ~/work-brain --name "My work" --principal "Your Name" --kind person --local
```

## What local mode turns off, and where

`"mode": "local"` in `animamesh.config.json` makes the engine refuse, at the
point each capability would act:

| Reach | In local mode |
|---|---|
| Delivery | Console only. Reports stay files in `reports/`; Slack, Discord, Gmail and Notion throw. |
| Read sources | Gmail, Google Calendar, Google Drive and OneDrive are never called; the agent sees an "off" section. The docs corpus reads only a local path; linked brains open only local checkouts. |
| Web search | Off, even when an agent declares `web:` and its harness supports it, so no query text leaves through a model vendor's search tool. |
| Engine feedback | A `defect-report` stays a draft in `drafts/defects/`; `defect file` refuses. Nothing reaches the public engine tracker. |
| Runtime | The cloud tier refuses the brain (beats and chat directions), `run --instance github:...` refuses, `slack listen` and `connect google` refuse. |

`anima-mesh validate` reports a local-mode config that reaches out (a chat
channel, a link without `localPath`, mail polling) as an error.

What remains is the model call. The harness you choose (a local CLI such as
Claude Code, or an API) is the one network path; use the assistant and
account your organization approves for that material.

## What `init --local` writes

- The config above, with `delivery.channels: ["console"]`.
- `CLAUDE.md` and `AGENTS.md`: the working agreement for any assistant
  session in the brain - focus first, OKF v0.2 frontmatter, the layout,
  the log, the constitution - plus the local boundary (never push to a
  personal or public remote, never copy contents into another brain or a
  public issue). Every `init` writes the agreement; only local brains get
  the boundary section.
- Agents on the `claude-code` harness by default, with network read sources
  and web budgets removed from their frontmatter.
- `ops/focus.md`, the calendar, nags, watch-list and schedule, and an
  engine-feedback note that keeps feedback inside the brain.
- `.claude/agents/` and `.opencode/agents/` for the hub, so an interactive
  session can work as the chief of staff.

## Working in a local brain

- **Interactively**: open the brain in Claude Code (or Codex). The
  `CLAUDE.md` it reads is the working agreement; start from the focus.
- **On a schedule**: `pnpm cli heartbeat --instance ~/work-brain` from an
  engine checkout runs the due agents through the local harness and prints
  the three-line brief. Schedule it with the OS (launchd, cron, Task
  Scheduler) if you want a daily beat; nothing else is needed.
- **Validate**: `pnpm cli validate ~/work-brain` after changes.
- **Where it lives**: `git init` the brain and keep any remote on storage
  your organization approves, or put it in the organization's OneDrive,
  SharePoint or Google Drive with `--storage synced`
  ([storage](storage.md)). The engine is public; the brain is not.
- **Linking**: a local brain may link to other brains only through local
  checkouts, and every link must be declared on both sides. Think twice
  before linking a proprietary brain to a personal one: the boundary is
  yours to keep.

## Converting an existing brain

Add `"mode": "local"` to its config, set `delivery.channels` to
`["console"]`, give every link a `localPath`, turn off mail polling, and
run `validate`. Removing cloud-tier deploy config and secrets is up to you;
the engine already refuses to run the brain there.
