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
- keeps project summaries, decisions, scratchpads, timelines, and rule folders
- injects lightweight Pietta context before the agent starts
- exposes slash commands and tools for remembering, grepping, updating, and deleting memory

## Current storage layout

For an agent named `default`, Pietta creates:

```text
~/.pi/pietta/agents/default/
├── memory.git/
└── memory/
    ├── README.md
    ├── profile/
    │   ├── preferences.md
    │   ├── environment.md
    │   └── habits.md
    ├── projects/
    │   └── <project-slug>/
    │       ├── SUMMARY.md
    │       ├── decisions.md
    │       ├── timeline.jsonl
    │       ├── scratchpad.md
    │       └── facts/
    ├── agent/
    ├── sessions/
    │   └── memory/
    ├── summaries/
    │   └── latest.md
    ├── inbox/
    │   └── candidates.jsonl
    └── rules/
        ├── project/
        ├── agent/
        └── generated/
```

## Project model

Projects are currently derived from the basename of the current working directory.

Example:

- cwd: `/home/jonahgam/pietta`
- project slug: `pietta`
- project memory dir: `projects/pietta/`

Project-scoped durable memories are written into:

```text
projects/<project-slug>/facts/
```

This means Pietta is project-aware, but projects are not yet first-class objects with their own metadata model beyond the directory layout.

## Rules model

Rules are plain markdown files stored in:

- `rules/project/`
- `rules/agent/`
- `rules/generated/`

Right now, rules are:

- created as folders with README stubs during init
- listed by the `/rules` command
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

Pietta injects a hidden context block that currently includes:

- the current agent id
- the memory root path
- memory discipline guidance
- the current project summary, if present
- the latest summary, if present
- a list of available rule file paths, if present

It does **not** automatically inject all memory files or rule contents.

## Search behavior

Pietta grep is designed to work like ripgrep.

Current grep scope is limited to the active project and non-project shared agent areas:

- current `projectDir`
- `profileDir`
- `agentNotesDir`
- `sessionMemoryDir`
- `rulesDir`
- `summariesDir`
- `inboxDir`

It deliberately does **not** grep other projects in the same agent repo.

## Slash commands

Current command surface:

- `/init` — initialize Pietta for the current or selected agent
- `/agent` — switch the active Pietta agent
- `/doctor` — audit and repair memory layout
- `/remember` — store a durable memory item
- `/memory list`
- `/memory recent`
- `/memory show <id>`
- `/memory grep <query>`
- `/memory update <id> [text]`
- `/memory delete <id>`
- `/rules` — list rule files
- `/agents` — list, add, or switch agents

## Registered tools

- `pietta_grep_memory`
- `pietta_write_memory`
- `pietta_update_memory`
- `pietta_delete_memory`

`pietta_grep_memory` is intended to be used exactly like ripgrep, including regex queries.

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

- per-agent git-backed repo layout
- scoped durable memory writing
- meaningful memory filenames
- memory grep
- project summaries and rule directories
- lightweight context injection

Not implemented yet:

- smart rule selection and just-in-time rule content injection
- cross-project or cross-agent sync
- semantic retrieval or embeddings
- first-class project metadata
- automatic rule generation workflows
- previous conversation indexing
