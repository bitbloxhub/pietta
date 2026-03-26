# AGENTS.md

Guidance for working in this repository.

## Project summary

Pietta is a Pi extension that implements local, git-backed memory per agent. Memory is organized as files inside an agent-specific repo and exposed through slash commands and tools.

Key ideas:

- file-first, grep-first memory
- one memory repo per agent
- scoped memory: `project`, `agent`, `session`
- lightweight injected context instead of stuffing all memory into the prompt
- Letta-inspired naming and filesystem organization

## Current implementation notes

### Memory roots

For the current agent, Pietta stores memory under:

```text
~/.pi/pietta/agents/<agent-id>/memory/
```

Important subdirectories:

- `profile/`
- `projects/<project-slug>/`
- `agent/`
- `sessions/memory/`
- `summaries/`
- `inbox/`
- `rules/project/`
- `rules/agent/`
- `rules/generated/`

### Project behavior

Projects are currently derived from `path.basename(cwd)` and slugified.

That means:

- project identity is directory-based
- project-scoped memories live in `projects/<slug>/facts/`
- grep should stay within the active project and shared non-project areas

Do not assume projects are globally unique objects yet.

### Rule behavior

Rules are plain markdown files in `rules/project`, `rules/agent`, and `rules/generated`.

Current behavior:

- rules are listed and searchable
- rule file paths are included in injected Pietta context
- rule contents are not automatically injected

If you extend rule support, prefer selective or just-in-time injection over always-on prompt bloat.

## Current command and tool expectations

### Slash commands

Primary search interface:

- `/memory grep <query>`

Treat it like ripgrep:

- plain text is allowed
- regex is allowed
- it should not search other projects

Other important commands:

- `/pietta-init`
- `/agent`
- `/pietta-doctor`
- `/remember`
- `/memory ...`
- `/rules`
- `/agents`

### Registered tools

- `pietta_grep_memory`
- `pietta_write_memory`
- `pietta_update_memory`
- `pietta_delete_memory`

`pietta_grep_memory` should be described and treated like ripgrep, including regex support.

## Memory policy

The current prompt guidance is intentionally forceful about preferences.

When extending prompts or tool guidance, preserve these behaviors:

- explicit user preferences are durable memory
- if the user says something is their preference, default, usual workflow, or recurring constraint, store it proactively
- do not wait for explicit confirmation unless the user says not to remember it
- never store secrets, credentials, or clearly temporary details

## Naming policy

Durable memory filenames should be meaningful and derived from content.

Examples:

- `user_preferences.md`
- `coding_preferences.md`
- `bug_repro_steps.md`

Do not reintroduce opaque `mem_*` naming for new entries.

## Coding notes

Follow the repo/user style preferences already in effect:

- use tabs for indentation
- no semicolons
- prefer trailing commas where applicable

When editing existing files in this repo:

- prefer small, surgical changes
- keep command/tool wording aligned with current behavior
- keep grep terminology consistent: use “grep” for the slash command path and “ripgrep-style” for behavior

## Code layout

Current source layout:

```text
src/
	index.ts                 # thin extension entrypoint and event wiring
	core/
		context.ts            # injected Pietta context construction
		git.ts                # git/worktree lifecycle and sync helpers
		layout.ts             # repo bootstrap, default files, path resolution for reads/writes
		memory.ts             # memory CRUD, grep, history, rendering helpers
		paths.ts              # storage roots, slugification, and memory path derivation
		state.ts              # persisted current-agent state and agent listing helpers
		types.ts              # shared Pietta types and constants
	commands/
		parsing.ts            # slash command parsing and autocomplete helpers
		register.ts           # slash command registration and handlers
	tools/
		register.ts           # tool registration for grep/write/update/delete
```

Module boundary guidance:

- keep `src/index.ts` as orchestration only
- keep git/worktree behavior in `src/core/git.ts`
- keep repo/bootstrap and read/write path setup in `src/core/layout.ts`
- keep memory file operations and rendering in `src/core/memory.ts`
- keep slash command parsing/registration out of core modules
- keep tool registration separate from command registration

## Good next steps

If you expand this project, the most natural next improvements are:

- selective rule content injection
- first-class project identity beyond cwd basename
- conversation history indexing/search
- approval flows for generated rules
- better provenance and dedupe for promoted memory
