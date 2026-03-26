# Pietta

Git-backed memory extension for Pi.

Pietta gives each agent its own local memory repo and organizes durable memory into project, agent, and session scopes. The current implementation is intentionally file-first and grep-first: memory lives in markdown and JSONL files, is easy to inspect by hand, and can be searched with ripgrep-style queries.

> [!WARNING]
> Pietta is mostly **agentically coded** and in **very early alpha**. Expect rough edges, incomplete behavior, breaking changes, and missing safeguards.
> Original planning session: https://pi.dev/session/#2fbdf54e0263917c0eeb27ea99c48018
> Original plan document: `ORIGINAL_PLAN.md`

## What it does

- creates a dedicated memory repo per agent under `~/.pi/pietta/agents/<agent-id>/`
- stores durable memory as normal files instead of an opaque database
- separates memory into `project`, `agent`, and `session` scopes
- keeps a simple top-level hierarchy of system, projects, sessions, rules, per-project timelines, and maintenance files
- injects lightweight Pietta context before the agent starts
- exposes slash commands and tools for remembering, grepping, updating, and deleting memory

## Current storage layout

For an agent named `default`, Pietta now prefers a simpler top-level hierarchy:

```text
~/.pi/pietta/agents/default/
├── memory.git/
└── memory/
    ├── README.md
    ├── system/
    │   ├── README.md
    │   └── <agent-chosen-files-and-subdirs>
    ├── projects/
    │   └── <project-slug>/
    │       ├── README.md
    │       ├── system/
    │       │   └── <agent-chosen-files-and-subdirs>
    │       ├── rules/
    │       └── timeline.jsonl
    ├── sessions/
    │   └── memory/
    ├── summaries/
    │   └── latest.md
    ├── inbox/
    │   └── candidates.jsonl
    ├── rules/
    │   ├── agent/
    │   └── generated/
    └── archive/
```

Notes:

- Pietta does **not** prescribe fixed subfolders inside `system/`
- Pietta does **not** prescribe fixed subfolders inside `projects/<slug>/`
- the agent can organize both `system/` and project memory however it decides
- each project also has a `projects/<slug>/system/` area for project-pinned memory
- no generic `/init` command is introduced; `/pietta-init` remains canonical

## Project model

Projects are currently derived from the basename of the current working directory.

Example:

- cwd: `/home/jonahgam/pietta`
- project slug: `pietta`
- project memory dir: `projects/pietta/`

Project-scoped durable memories default to the project root and supporting subpaths under:

```text
projects/<project-slug>/
```

Project-scoped rules, conventions, and stable preferences should generally live under:

```text
projects/<project-slug>/system/
```

Ordinary project facts can live directly under:

```text
projects/<project-slug>/
```

This means Pietta is project-aware, but projects are not yet first-class objects with their own metadata model beyond the directory layout.

By default, project remembers now prefer `projects/<slug>/system/` for high-priority project rules/conventions/preferences and `projects/<slug>/` for ordinary project facts, unless the agent explicitly chooses a subpath.

## Rules model

Rules are plain markdown files stored in:

- `projects/<slug>/rules/` for project rules
- `rules/agent/` for agent rules
- `rules/generated/` for generated rules

Right now, rules are:

- searchable through Pietta grep
- referenced in injected context by file path

Rule contents are **not** yet automatically selected and injected based on relevance. At the moment, Pietta injects the list of available rule files, not their contents.

## Memory items

Durable memory entries are markdown files with frontmatter plus body text.

New entries use meaningful Letta-style names derived from their content instead of opaque `mem_*` IDs.

Examples:

- `project/user_preferences`
- `agent/coding_preferences`
- `session/bug_repro_steps`

Duplicate names get numeric suffixes like `_2`.

## What gets injected before agent start

Pietta injects a hidden context block that now emphasizes hierarchy:

- the current agent id
- the memory root path
- memory discipline guidance
- the active hierarchy roots (`system/`, project, project system, session, rules, inbox)
- the current project summary, if present
- the latest summary, if present
- pinned `system/` and project system memory snippets when available
- a list of available rule file paths, if present
- a lightweight tree view of pinned system memory

It still does **not** automatically inject the full contents of every memory file.

## Search behavior

Pietta grep is designed to work like ripgrep.

Current grep scope is limited to the active project and shared agent areas for the current agent:

- current `projectDir` (including `projects/<slug>/rules/`)
- pinned `system/` and `projects/<slug>/system/` memory
- shared `rulesDir` (`rules/agent/` and `rules/generated/`)
- `sessionMemoryDir`
- `summariesDir`
- `inboxDir`

## Slash commands

Current command surface:

- `/pietta-init` — initialize or re-analyze Pietta for the current or selected agent
  - ensures the Pietta layout exists for the selected agent
  - sends a Letta-style user message so the agent can inspect the project and update memory through Pietta tools
- `/agent` — switch the active Pietta agent
- `/pietta-doctor` — audit and repair memory layout
- `/remember` — promote a durable lesson, preference, rule, or fact into the right hierarchy
  - sends a Letta-style user message so the agent can infer, rewrite, and store the right durable memory from context
  - explicit scope and `path=subdir/file_name` are passed through as strong placement hints for the agent to follow
- `/memory list`
- `/memory recent`
- `/memory show <id>`
- `/memory grep <query>`
- `/memory update <id> [text]`
- `/memory delete <id>`
- `/memory sync`
- `/memory sync-strategy <ours|theirs>`
- `/memory worktrees`
- `/memory worktree-add <name>`
- `/memory worktree-remove <name>`
- `/agents` — list, add, or switch agents

## Registered tools

- `pietta_grep_memory`
- `pietta_write_memory`
- `pietta_update_memory`
- `pietta_delete_memory`

`pietta_grep_memory` is intended to be used exactly like ripgrep, including regex queries.

## Git behavior

Pietta now persists memory changes as real git commits inside each agent memory repo.

- writes commit as `feat(memory): remember <id>`
- updates commit as `docs(memory): update <id>`
- deletes commit as `chore(memory): delete <id>`
  Each agent still has a canonical bare repo at `~/.pi/pietta/agents/<agent-id>/memory.git` and a primary working tree at `~/.pi/pietta/agents/<agent-id>/memory/`.

Mutating and session-scoped read operations now automatically use a per-session linked worktree when a Pi session id or session file is available. Session worktrees live under `~/.pi/pietta/agents/<agent-id>/worktrees/` and use named branches like `pietta/session/<session-key>` instead of detached HEADs.

Before a session mutation, Pietta rebases that session branch onto the canonical branch. After the commit is created, Pietta fast-forwards the canonical branch to include the session commit. `/pietta-doctor` reports the attached worktrees so concurrent session state is visible and easy to audit.
If the canonical memory repo has additional git remotes configured, Pietta fetches them automatically before reads and mutations. On read paths, Pietta only fast-forwards the canonical branch from `origin` when that update is a clean fast-forward, and it does not merge other remotes. On mutation paths and `/memory sync`, Pietta also merges remote changes into the canonical branch using the configured sync strategy and pushes local commits back out. If a push is rejected as non-fast-forward, Pietta fetches, auto-merges the remote branch, and retries the push.

Sync strategy is configurable with `/memory sync-strategy <ours|theirs>` and stored in git config as `pietta.syncStrategy`. The default is `theirs`.

Use `/memory sync` to force a remote fetch/merge/push cycle on demand.

### Adding sync remotes

After Pietta initializes an agent, add remotes to the canonical worktree like normal git remotes:

```bash
git -C ~/.pi/pietta/agents/<agent-id>/memory remote add <name> <url>
git -C ~/.pi/pietta/agents/<agent-id>/memory fetch <name>
```

`origin` is the local bare repo managed by Pietta. Additional remotes are fetched automatically, shown in `/pietta-doctor`, included in `/memory sync`, and pushed to after successful canonical updates.

### Seeding Pietta from an existing remote repo

One simple way to start from an existing remote memory repo is:

```bash
pi /pietta-init
cd ~/.pi/pietta/agents/<agent-id>/memory
git remote add upstream <url>
git fetch upstream
git merge --allow-unrelated-histories upstream/main
```

Then run `/memory sync` so Pietta fetches, reconciles, and pushes the resulting canonical branch. If the remote uses a branch name other than `main`, substitute that branch name in the merge command.

## Development

Install dependencies:

```bash
pnpm install
```

Type-check:

```bash
pnpm exec tsc -p tsconfig.json --noEmit
```

Watch mode:

```bash
pnpm run dev
```

## Status

Pietta is currently an early file-first implementation of the original plan in `ORIGINAL_PLAN.md`, based on the original planning session: https://pi.dev/session/#2fbdf54e0263917c0eeb27ea99c48018

Implemented now:

- Letta-inspired `system/` vs project hierarchy
- real git commits for memory writes, updates, and deletes
- automatic per-session worktrees for concurrent mutations
- attached worktree visibility in `/pietta-doctor`
- scoped durable memory writing
- hierarchy-aware remember placement for pinned agent memory
- meaningful memory filenames
- memory grep
- simple top-level hierarchy without prescribed subfolders inside `system/` or `projects/<slug>/`
- lightweight context injection with pinned system snippets

Not implemented yet:

- richer multi-step interactive `/pietta-init` interviews beyond the current user-message-driven init flow
- smart rule selection and just-in-time rule content injection
- cross-project or cross-agent sync
- semantic retrieval or embeddings
- first-class project metadata
- automatic rule generation workflows
- previous conversation indexing
