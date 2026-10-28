# Where a brain lives: git, OneDrive, Google Drive

A brain is a folder: an OKF bundle, a ledger, reports, approvals and drafts.
Since v2.4.0 that folder can live in a git repository or in a drive a sync
client keeps on every machine: OneDrive, SharePoint, Google Drive or
Dropbox. Pick git when you have it; pick a synced drive when your
organization runs on one and git is not available.

| | Git | Synced drive |
|---|---|---|
| Two people edit one file | git merges, or asks you to | the client keeps both: a conflict copy |
| History | `git log`, every version | the drive's version history, `bundle/log.md`, the ledger |
| Cloud tier (Cloudflare Workers) | yes | no: laptop and interactive only |
| Who can read it | repository access | folder sharing |
| Best for | engineers, the cloud tier | business teams, locked-down enterprises |

## Set one up

```bash
pnpm cli init "$HOME/OneDrive - Acme/brains/my-brain" --name "My work" --principal "Ada" \
  --kind person --local --storage synced --provider onedrive
pnpm cli doctor --instance "$HOME/OneDrive - Acme/brains/my-brain"
```

`--storage synced` writes `"storage": { "kind": "synced", "provider": ...,
"runner": <this machine> }` to the config and a "Synced folder, not git"
section into the brain's `CLAUDE.md`. Add `--local` when the brain holds
proprietary knowledge ([local mode](local-only.md)); the two are
independent, and they fit together.

Then, on every machine that opens the brain:

1. **Keep the folder downloaded.** OneDrive: right-click, "Always keep on
   this device". Google Drive for desktop: "Available offline", or mirror
   mode. Dropbox: "Make available offline".
2. **Set a stable machine id** in your shell profile:
   `export ANIMAMESH_WRITER=work-laptop`. Without it the engine uses the
   first part of the host name.
3. **Keep the engine outside the drive.** Clone it to a normal folder
   (`~/dev`, `C:\dev`). Its `node_modules` holds thousands of files and
   symlinks that sync clients copy badly or drop.
4. **Keep secrets out of the drive.** Put any keys in your shell
   environment; a `.env` file in the folder would reach every machine and
   the drive's cloud. A local brain on the `claude-code` harness needs none.

## What the engine does differently in a synced folder

Each row is an edge case of sync clients, and the engine's answer in code:

| Edge case | What happens without care | What the engine does |
|---|---|---|
| Two machines append to the ledger | the client makes a conflict copy; history splits | each machine appends to its own shard, `ledger/actions.<machine>.jsonl`; reads merge every shard and any conflict copy, drop exact duplicates, and order by time |
| Two machines run the daily beat | sync lag lets both run every due agent | only `storage.runner` runs `heartbeat`; other machines refuse unless `--force` (use it only when the runner is off). A machine that reads the runner's shard sees today's runs and skips them |
| Two people edit one concept | `focus-LAPTOP.md`, `focus (1).md`, `focus (conflicted copy).md` sit beside the original, and both load | `validate` warns, `doctor` errors, and the hub's brief gets a P2 line naming each copy until someone merges and deletes it |
| The client uploads a file mid-write | another machine reads half a report | every engine write goes to a temp file and is renamed into place, which is atomic: readers see the old file or the new one |
| A file is only in the cloud | reading it fails or blocks; an agent could think the fact is missing | only "does not exist" counts as missing; any other read failure stops the run with "make the folder available offline" |
| Names Windows or SharePoint refuse | the file never syncs to some machines | `validate` warns and `doctor` errors on `< > : " \| ? * \`, trailing dots or spaces, reserved names (`CON`, `desktop.ini`), Office lock files (`~$...`), names differing only by case, and relative paths over 200 characters |
| An approval decided on one machine, pending on another | a conflict copy could bring "pending" back | approvals are one record per id, and a decision always outranks pending |
| `node_modules`, `.git`, build output, symlinks in the folder | slow syncs, broken links, a corrupted repository | `doctor` flags each one |
| Files saved with a byte-order mark or CRLF line endings | frontmatter not recognized | both are read correctly |

## `anima-mesh doctor`

```text
doctor: /Users/ada/OneDrive - Acme/brains/my-brain
  ✓ storage: synced storage (onedrive), folder is in onedrive
  ✓ runner: this machine (work-laptop) is the runner
  ✓ contents: nothing in the brain that must not sync
  ✓ readable: 412 files read in 38 ms
  ✓ writable: reports/ accepts an atomic write
  ✗ conflicts: bundle/ops/focus-WORKPC.md: OneDrive conflict copy of focus.md (from WORKPC); merge it into the original, then delete it
  ✓ names: every name is valid on Windows, OneDrive, SharePoint and Google Drive
  ✓ ledger: 212 entries across 2 file(s): ledger/actions.work-laptop.jsonl, ledger/actions.work-pc.jsonl
NEEDS ATTENTION - 1 error(s), 0 warning(s)
```

Run it after setup, after a machine joins, and whenever the brief mentions
a conflict copy. It also works on a git brain, and warns when a git brain's
folder sits inside a drive.

## Resolving a conflict copy

Open both files, keep what is right in the original (and update its
`generated:` and, when you checked something, `verified:`), delete the copy,
and add a line to `bundle/log.md`. An assistant session in the brain can do
this; its `CLAUDE.md` says how.

## Moving between git and a drive

- **Git to a drive**: copy the folder without `.git`, `node_modules` or
  `.env*`; set `storage.kind: "synced"` and a runner; run `doctor`. The old
  `ledger/actions.jsonl` keeps working: reads merge it with the new shards.
- **A drive to git**: `git init` a copy outside the drive, set
  `storage.kind: "git"` (or remove `storage`); keep the shards, which merge
  the same way.

## Tested

On 2026-10-27, on macOS with Google Drive for desktop and OneDrive (both on
the File Provider framework): `init`, `doctor`, a full offline heartbeat,
a second machine's run writing its own shard and seeing the first machine's
runs, a simulated conflict copy flagged by `doctor`, no temp files left
behind, and the shards present in Google Drive's cloud after sync. Windows
and Dropbox follow the same file rules but were not tested live.
