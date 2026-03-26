import type { AutocompleteItem } from "@mariozechner/pi-tui"
import {
	getMemoryItemIdsSync,
	getMemoryWorktreeKeysSync,
} from "../core/memory.js"
import { sanitizeAgentId } from "../core/paths.js"
import { getAgentIds, getCurrentAgentIdSync } from "../core/state.js"
import {
	SCOPE_VALUES,
	type AgentsArgs,
	type MemoryArgs,
	type Scope,
} from "../core/types.js"

export function toAutocompleteItems(
	values: string[],
	prefix: string,
	labelPrefix?: string,
): AutocompleteItem[] | null {
	const items = values
		.filter((value) => value.startsWith(prefix))
		.map((value) => ({
			value,
			label: labelPrefix ? `${labelPrefix}${value}` : value,
		}))
	return items.length > 0 ? items : null
}

export function getAgentsCommandCompletions(
	prefix: string,
): AutocompleteItem[] | null {
	const trimmed = prefix.trimStart()
	const endsWithSpace = /\s$/.test(prefix)
	const parts = trimmed.split(/\s+/).filter(Boolean)
	const command = parts[0] ?? ""
	const commands = ["add", "switch", "use"]
	const agents = getAgentIds()
	if (!trimmed) return commands.map((value) => ({ value, label: value }))
	if (parts.length === 1 && !endsWithSpace)
		return toAutocompleteItems(commands, command)
	if (["switch", "use"].includes(command)) {
		const selectorPrefix = endsWithSpace ? "" : parts.slice(1).join(" ")
		return toAutocompleteItems(agents, selectorPrefix, `${command} `)
	}
	return null
}

export function getRememberCompletions(
	prefix: string,
): AutocompleteItem[] | null {
	const trimmed = prefix.trimStart()
	if (!trimmed) {
		return [...SCOPE_VALUES].map((scope) => ({
			value: `${scope} `,
			label: `${scope} memory`,
		}))
	}
	if (!trimmed.includes(" ")) {
		return [...SCOPE_VALUES]
			.filter((scope) => scope.startsWith(trimmed))
			.map((scope) => ({ value: `${scope} `, label: `${scope} memory` }))
	}
	return null
}

export function getMemoryCommandCompletions(
	prefix: string,
): AutocompleteItem[] | null {
	const trimmed = prefix.trimStart()
	const endsWithSpace = /\s$/.test(prefix)
	const parts = trimmed.split(/\s+/).filter(Boolean)
	const command = parts[0] ?? ""
	const commands = [
		"list",
		"recent",
		"show",
		"history",
		"grep",
		"update",
		"delete",
		"sync",
		"sync-strategy",
		"worktrees",
		"worktree-add",
		"worktree-remove",
	]
	const memoryIds = getMemoryItemIdsSync(process.cwd(), getCurrentAgentIdSync())
	const worktreeKeys = getMemoryWorktreeKeysSync(
		process.cwd(),
		getCurrentAgentIdSync(),
	)
	if (!trimmed) return commands.map((value) => ({ value, label: value }))
	if (parts.length === 1 && !endsWithSpace)
		return toAutocompleteItems(commands, command)
	if (["show", "history", "update", "delete"].includes(command)) {
		const selectorPrefix = endsWithSpace ? "" : parts.slice(1).join(" ")
		return toAutocompleteItems(memoryIds, selectorPrefix, `${command} `)
	}
	if (["worktree-add", "worktree-remove"].includes(command)) {
		const selectorPrefix = endsWithSpace ? "" : parts.slice(1).join(" ")
		return toAutocompleteItems(worktreeKeys, selectorPrefix, `${command} `)
	}
	if (command === "sync-strategy") {
		const selectorPrefix = endsWithSpace ? "" : parts.slice(1).join(" ")
		return toAutocompleteItems(
			["ours", "theirs"],
			selectorPrefix,
			`${command} `,
		)
	}
	return null
}

export function parseAgentsArgs(args: string): AgentsArgs {
	const [command = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean)
	return { command, value: rest.join(" ") || undefined }
}

export function parseRememberArgs(args: string): {
	scope: Scope
	text: string
} {
	const trimmed = args.trim()
	if (!trimmed) return { scope: "project", text: "" }
	const [first, ...rest] = trimmed.split(/\s+/)
	if ((SCOPE_VALUES as readonly string[]).includes(first))
		return { scope: first as Scope, text: rest.join(" ") }
	return { scope: "project", text: trimmed }
}

export function parseMemoryArgs(args: string): MemoryArgs {
	const trimmed = args.trim()
	if (!trimmed) return { command: "list" }
	const [command, ...rest] = trimmed.split(/\s+/)
	if (
		command === "show" ||
		command === "history" ||
		command === "delete" ||
		command === "worktree-add" ||
		command === "worktree-remove" ||
		command === "sync-strategy"
	)
		return { command, selector: rest.join(" ") || undefined }
	if (command === "update")
		return { command, selector: rest[0], text: rest.slice(1).join(" ") }
	if (command === "grep" || command === "search")
		return { command: "grep", text: rest.join(" ") }
	if (
		command === "list" ||
		command === "recent" ||
		command === "worktrees" ||
		command === "sync"
	)
		return { command }
	return { command: "grep", text: trimmed }
}

export function normalizeAgentArg(
	args: string,
	currentAgentId: string,
): string {
	return sanitizeAgentId(args || currentAgentId)
}
