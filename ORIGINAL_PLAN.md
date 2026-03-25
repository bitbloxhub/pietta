# Pietta Memory Plan

## Goal

Build Pi memory as a **real git-backed repo per agent** with support for **multiple agents**, closer to Letta's agent/filesystem model than a mem0-style memory database.

## Core recommendation

Use a **Letta-style repo/filesystem architecture** as the foundation, then layer on:

- **rho-style observability**
- **oh-my-pi-style startup injection, memory commands, and just-in-time rules injection**
- **mem0-style extraction and scoped promotion** as implementation ideas, not the source of truth

## Source of truth

Make memory a set of real local repos, ideally **one git repo per agent**, for example:

- `~/.pi/agents/<agent-id>/memory.git` for the bare repo
- `~/.pi/agents/<agent-id>/memory/` for the working tree

Shared cross-agent memory can either live in a separate shared repo or be synchronized selectively between agent repos.
For this project, the same idea can live under the Pietta project directory.

The key principle:

- **Per-agent git repo = canonical memory**
- **summaries = generated artifacts**
- **search/retrieval should work directly from files first**

Any future derived index should be rebuildable entirely from the repo.

## Why not mem0 as the core

mem0 has good ideas:

- layered scopes
- extraction
- dedupe / conflict resolution
- semantic search

But as the primary architecture it is too:

- API-centric
- opaque compared to files
- harder to inspect and manually edit
- less natural for coding-agent workflows

For Pietta, memory should be:

- local-first
- inspectable
- editable
- revertible
- branchable
- easy to diff and sync

## Multi-agent direction

Support **multiple agents like Letta**, each with their own working context and **their own memory repo**, while sharing selected memory through explicit shared scopes or synchronization.

Recommended scopes:

- `global`
- `user`
- `project`
- `agent`
- `session`
- optional shared team/org scope later

Each agent should be able to:

- read shared/project memory
- write its own session and agent memory
- promote stable learnings into shared/project memory
- search across allowed scopes
- preserve provenance for every promoted fact

Subagents can still be useful as a pattern, but Pietta does **not** need a bespoke subagent runtime in v1. If one agent wants another agent to do work, that can just run as a separate Pi process with its own repo and conversation history.

## Architecture model

### 1. Canonical storage: per-agent git-backed memory repos

Suggested layout:
Each agent gets its own canonical repo. Shared memory should not blur ownership by default — it should either live in a dedicated shared repo or be copied/promoted across agent repos with provenance preserved.

```text
~/.pi/agents/
├── <agent-id>/
│   ├── memory.git/              # bare canonical repo
│   └── memory/                  # working tree
│       ├── README.md
│       ├── profile/
│       │   ├── preferences.md
│       │   ├── environment.md
│       │   └── habits.md
│       ├── projects/
│       │   ├── <project-slug>/
│       │   │   ├── SUMMARY.md
│       │   │   ├── facts.md
│       │   │   ├── decisions.md
│       │   │   ├── timeline.jsonl
│       │   │   └── scratchpad.md
│       ├── sessions/
│       │   └── <session-id>.jsonl
│       ├── summaries/
│       │   └── latest.md
│       ├── inbox/
│       │   └── candidates.jsonl
│       ├── archive/
│       │   └── ...
│       └── rules/
│           ├── project/
│           ├── agent/
│           └── generated/
└── shared/
    ├── memory.git/                 # optional shared canonical repo
    └── memory/
        ├── agents/
        ├── projects/
        └── rules/
```

### 2. Human-facing memory artifacts

Use markdown for durable, human-important memory.

Use JSONL for append-only event streams, observations, and candidate promotions.

Example memory item:

```md
---
id: mem_01hv...
scope: project
project: pietta
agent: planner
kind: preference
confidence: 0.93
sources:
  - session: abc123
  - file: /path/to/AGENTS.md
created_at: 2026-03-25T12:00:00Z
updated_at: 2026-03-25T12:00:00Z
---

Use tabs by default unless overridden by .editorconfig.
```

### 3. Retrieval layer

Retrieval should be practical, grep-friendly, and secondary to the repo:

- lexical search
- frontmatter / path / tag filtering
- previous-conversation search
- recency
- confidence
- pinning / importance
- scope filtering
  Good models can often work well with grep, structured files, summaries, and conversation search alone. Treat richer indexing as a later optimization, not a foundation.

### 4. Memory write path

Use a cautious promotion pipeline:

- explicit writes by user or agent
- post-session candidate extraction
- promotion into durable memory when confidence is high
- dedupe / merge / conflict resolution
- preserve provenance

### 5. Rules and context injection

Pietta should also borrow from oh-my-pi's rules system, especially the idea of just-in-time context injection. Instead of always pinning every instruction in context, rules can be stored as files and injected only when relevant.

Recommended rule categories:

- `rules/project/` — repo-specific conventions and pitfalls
- `rules/agent/` — agent-specific behavior and workflow rules
- `rules/generated/` — rules proposed or synthesized by agents from repeated mistakes or explicit user feedback

These rules should be:

- human-editable
- versioned in git
- inspectable like any other memory artifact
- eligible for explicit approval flows when agent-generated

Agents should be able to create and update candidate rules, especially when they notice repeated failures, stable conventions, or recurring user corrections. This gives Pietta a lightweight "inject into context when needed" mechanism without forcing everything into always-on memory.

Good auto-promote candidates:

- stable user preferences
- repo conventions
- environment constraints
- repeated workflow habits
- project facts and decisions

Bad auto-promote candidates:

- temporary plans
- speculative assumptions
- hallucinated conclusions
- secrets or credentials

## UX and observability

This should follow rho and oh-my-pi more than mem0.

Required capabilities:

- inspect what memory exists
- search it
- edit it
- explain where it came from
- forget or prune it
- rebuild any optional derived indexes if they exist
- export or sync it

Suggested commands:
Memory lifecycle and inspection:

- `/init` — deep memory initialization for the current agent and project
- `/doctor` — audit and refine memory structure without full re-init
- `/remember [text]` — explicitly promote something into memory
- `/memory` — inspect memory, recent entries, and provenance
- `/search` — search messages, prior conversations, memory files, and rule files
- `/rules` — inspect and manage active rules / candidate rules
  Agent and conversation management:
- `/agents`
- `/pin`
- `/unpin`
- `/rename <name>`
- `/description <text>`
- agents should be able to search previous conversations across their own history, not just the active session
  Keep the command surface small in v1. Prefer a few composable commands over lots of specialized commands.

Parallel agent execution can happen through separate Pi processes rather than a dedicated built-in subagent tool.

### Letta Code slash command cues

After reviewing Letta Code's slash command docs, the most relevant commands for Pietta's design are:

- `/agents` — Letta treats agents as first-class objects, which strongly supports Pietta's multi-agent design
- `/init`, `/doctor`, `/remember`, `/memory` — Letta has an explicit memory lifecycle, not just passive retrieval
- `/search` - Letta separates message search from memory inspection, which Pietta should preserve, and Pietta should let agents search prior conversations beyond the current session
- `/pin`, `/unpin`, `/rename`, `/description`, `/export` — agent identity and portability matter in long-lived systems
- oh-my-pi's rules system / TTSR-style just-in-time injection is also a strong cue: Pietta should support rule files that activate only when relevant, instead of bloating base context
  Pietta should adopt the same idea: memory is not only storage, but an operational surface with commands for initialization, auditing, recall, promotion, cleanup, multi-agent coordination, and search across previous conversations — but it should keep the command surface compact.

## Letta influence

Borrow from Letta:

- file/folder mental model
- attachable knowledge per agent
- file browsing/search tools
- project-like organization of memory and knowledge
- explicit slash commands for agent switching, memory initialization, memory repair, and manual remembering
- the distinction between agents and conversations

## Potential later options

These are explicitly later-phase enhancements, not part of the foundation:

- SQLite-backed metadata or conversation indexes for faster filtered search
- vector / embedding indexes for fuzzy semantic recall across large memory corpora
- additional derived caches for ranking, recency scoring, or cross-agent search acceleration

All of these should remain optional and rebuildable from the per-agent git repos.

- a dedicated subagent orchestration layer only if separate Pi processes prove insufficient
  Do **not** stop at a virtual filesystem only. Make it a real repo.

## mem0 influence

Borrow from mem0:

- extraction pipeline
- dedupe and conflict handling
- metadata filters
  Potentially add semantic retrieval later, but do **not** require embeddings or a vector database for the initial design.
  Do **not** make mem0-style database/API storage the primary source of truth.

## rho and oh-my-pi influence

Borrow from rho:

- local-first memory
- strong observability
- inspect/search/edit learned state
- explicit memory viewer concept

Borrow from oh-my-pi:

- compact startup injection
- per-project memory isolation
- memory management commands
- summary artifacts exposed to the agent
- the rules system / TTSR idea: rules that inject into context only when needed
- letting agents author or propose new rules from repeated corrections, patterns, or explicit instructions
- keeping the active context lean instead of pinning too much all the time

## Final recommendation

For Pietta, the best design is:

> A **real git-backed memory repo per agent** with **multi-agent scopes**, **human-editable artifacts**, **grep-first retrieval**, and **rule files that can be injected into context when needed**.

In short:

> **Use Letta-style per-agent repo/filesystem architecture for the foundation, rely on grep + file structure first, keep the command/tool surface small, and treat richer indexing or vector search as optional later enhancements.**
