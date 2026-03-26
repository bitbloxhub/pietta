import path from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import {
	deleteMemoryWorktree,
	deleteSessionWorktreeForAgent,
	getConflictResolutionStrategy,
	listMemoryWorktrees,
	pushCanonicalBranchToBare,
	reconcileCanonicalBranchWithGitRemotes,
	renderSyncStatus,
	setConflictResolutionStrategy,
} from "../core/git.js"
import { ensureAgentLayout, resolveReadPaths } from "../core/layout.js"
import {
	collectMemoryItemsFromPaths,
	deleteMemoryItem,
	findMemoryItemInPaths,
	getMemoryHistoryFromPaths,
	grepMemoryInPaths,
	remember,
	renderMemoryItem,
	renderMemoryList,
	renderMemoryOverview,
	updateMemoryItem,
} from "../core/memory.js"
import {
	getCanonicalWorkTree,
	getPaths,
	sanitizeAgentId,
	slugifyWorktreeKey,
} from "../core/paths.js"
import { getAgentIds } from "../core/state.js"
import { EXTENSION_NAME } from "../core/types.js"
import {
	getAgentsCommandCompletions,
	getMemoryCommandCompletions,
	getRememberCompletions,
	parseAgentsArgs,
	parseMemoryArgs,
	parseRememberArgs,
	toAutocompleteItems,
} from "./parsing.js"

export function registerCommands(
	pi: ExtensionAPI,
	getCurrentAgentId: () => string,
	syncState: () => Promise<void>,
	setCurrentAgent: (agentId: string) => Promise<void>,
) {
	pi.registerCommand("pietta-init", {
		description: "Initialize Pietta memory for the current or selected agent",
		getArgumentCompletions: (prefix) =>
			toAutocompleteItems(getAgentIds(), prefix),
		handler: async (args, ctx) => {
			await syncState()
			const agentId = sanitizeAgentId(args || getCurrentAgentId())
			const result = await ensureAgentLayout(pi, ctx.cwd, agentId)
			await setCurrentAgent(agentId)
			ctx.ui.notify(
				result.created.length > 0
					? `Initialized Pietta for ${agentId} (${result.created.length} paths created)`
					: `Pietta already initialized for ${agentId}`,
				"info",
			)
		},
	})

	pi.registerCommand("agent", {
		description: "Switch to a Pietta agent by name",
		getArgumentCompletions: (prefix) =>
			toAutocompleteItems(getAgentIds(), prefix),
		handler: async (args, ctx) => {
			await syncState()
			const agentId = sanitizeAgentId(args)
			await ensureAgentLayout(pi, ctx.cwd, agentId)
			await setCurrentAgent(agentId)
			ctx.ui.setStatus(
				EXTENSION_NAME,
				ctx.ui.theme.fg("accent", `pietta:${agentId}`),
			)
			ctx.ui.notify(`Switched Pietta agent to ${agentId}`, "info")
		},
	})

	pi.registerCommand("pietta-doctor", {
		description: "Audit and repair Pietta memory layout",
		getArgumentCompletions: (prefix) =>
			toAutocompleteItems(getAgentIds(), prefix),
		handler: async (args, ctx) => {
			await syncState()
			const agentId = sanitizeAgentId(args || getCurrentAgentId())
			const result = await ensureAgentLayout(pi, ctx.cwd, agentId)
			ctx.ui.notify(
				`Pietta doctor complete\n\n${await renderMemoryOverview(pi, ctx.cwd, agentId)}\n\nCreated: ${result.created.length}`,
				"info",
			)
		},
	})

	pi.registerCommand("remember", {
		description: "Store a durable Pietta memory entry",
		getArgumentCompletions: getRememberCompletions,
		handler: async (args, ctx) => {
			await syncState()
			const remembered = parseRememberArgs(args)
			let text = remembered.text
			if (!text)
				text = (await ctx.ui.editor("Remember what?", ""))?.trim() || ""
			if (!text) {
				ctx.ui.notify("Nothing to remember", "warning")
				return
			}
			const filePath = await remember(pi, ctx, getCurrentAgentId(), {
				text,
				scope: remembered.scope,
				kind: "fact",
				confidence: 0.9,
			})
			ctx.ui.notify(`Remembered in ${filePath}`, "info")
		},
	})

	pi.registerCommand("memory", {
		description: "Inspect, show, grep, sync, update, or delete Pietta memory",
		getArgumentCompletions: getMemoryCommandCompletions,
		handler: async (args, ctx) => {
			await syncState()
			const parsed = parseMemoryArgs(args)
			const currentAgentId = getCurrentAgentId()
			if (parsed.command === "list" || parsed.command === "recent") {
				const paths = await resolveReadPaths(pi, ctx, currentAgentId)
				ctx.ui.notify(
					renderMemoryList(await collectMemoryItemsFromPaths(paths), 20),
					"info",
				)
				return
			}
			if (parsed.command === "show") {
				if (!parsed.selector) {
					ctx.ui.notify("Usage: /memory show <id>", "warning")
					return
				}
				const paths = await resolveReadPaths(pi, ctx, currentAgentId)
				const item = await findMemoryItemInPaths(paths, parsed.selector)
				ctx.ui.notify(
					item
						? renderMemoryItem(item)
						: `No memory item found for ${parsed.selector}`,
					"info",
				)
				return
			}
			if (parsed.command === "history") {
				if (!parsed.selector) {
					ctx.ui.notify("Usage: /memory history <id>", "warning")
					return
				}
				const paths = await resolveReadPaths(pi, ctx, currentAgentId)
				ctx.ui.notify(
					await getMemoryHistoryFromPaths(pi, paths, parsed.selector, 20),
					"info",
				)
				return
			}
			if (parsed.command === "update") {
				if (!parsed.selector) {
					ctx.ui.notify("Usage: /memory update <id> [text]", "warning")
					return
				}
				let text = parsed.text?.trim() || ""
				if (!text)
					text =
						(
							await ctx.ui.editor(`Update memory ${parsed.selector}`, "")
						)?.trim() || ""
				if (!text) {
					ctx.ui.notify("Nothing to update", "warning")
					return
				}
				const updated = await updateMemoryItem(
					pi,
					ctx,
					currentAgentId,
					parsed.selector,
					text,
				)
				ctx.ui.notify(
					`Updated ${updated.id}\n\n${renderMemoryItem(updated)}`,
					"info",
				)
				return
			}
			if (parsed.command === "delete") {
				if (!parsed.selector) {
					ctx.ui.notify("Usage: /memory delete <id>", "warning")
					return
				}
				const deleted = await deleteMemoryItem(
					pi,
					ctx,
					currentAgentId,
					parsed.selector,
				)
				ctx.ui.notify(`Deleted ${deleted.id}\n${deleted.filePath}`, "info")
				return
			}
			if (parsed.command === "sync") {
				const { paths } = await ensureAgentLayout(pi, ctx.cwd, currentAgentId)
				await reconcileCanonicalBranchWithGitRemotes(pi, paths)
				await pushCanonicalBranchToBare(pi, paths)
				ctx.ui.notify(
					[
						"Pietta sync complete",
						"",
						...(await renderSyncStatus(pi, paths)),
					].join("\n"),
					"info",
				)
				return
			}
			if (parsed.command === "sync-strategy") {
				const { paths } = await ensureAgentLayout(pi, ctx.cwd, currentAgentId)
				const canonicalWorkTree = getCanonicalWorkTree(paths)
				if (!parsed.selector) {
					const strategy = await getConflictResolutionStrategy(
						pi,
						canonicalWorkTree,
					)
					ctx.ui.notify(`Pietta sync strategy: ${strategy}`, "info")
					return
				}
				if (parsed.selector !== "ours" && parsed.selector !== "theirs") {
					ctx.ui.notify("Usage: /memory sync-strategy <ours|theirs>", "warning")
					return
				}
				await setConflictResolutionStrategy(
					pi,
					canonicalWorkTree,
					parsed.selector,
				)
				ctx.ui.notify(`Set Pietta sync strategy to ${parsed.selector}`, "info")
				return
			}
			if (parsed.command === "worktrees") {
				const { paths } = await ensureAgentLayout(pi, ctx.cwd, currentAgentId)
				const worktrees = await listMemoryWorktrees(pi, paths)
				ctx.ui.notify(
					worktrees.length > 0
						? worktrees
								.map(
									(worktree) =>
										`- ${worktree.path}${worktree.branch ? ` [${worktree.branch}]` : " [detached]"}`,
								)
								.join("\n")
						: "No worktrees found",
					"info",
				)
				return
			}
			if (parsed.command === "worktree-add") {
				if (!parsed.selector) {
					ctx.ui.notify("Usage: /memory worktree-add <name>", "warning")
					return
				}
				const worktreeKey = slugifyWorktreeKey(parsed.selector)
				const basePaths = getPaths(ctx.cwd, currentAgentId)
				await ensureAgentLayout(pi, ctx.cwd, currentAgentId, worktreeKey)
				ctx.ui.notify(
					`Attached worktree ${worktreeKey} at ${path.join(basePaths.worktreesDir, worktreeKey)}`,
					"info",
				)
				return
			}
			if (parsed.command === "worktree-remove") {
				if (!parsed.selector) {
					ctx.ui.notify("Usage: /memory worktree-remove <name>", "warning")
					return
				}
				const worktreeKey = slugifyWorktreeKey(parsed.selector)
				await deleteMemoryWorktree(
					pi,
					getPaths(ctx.cwd, currentAgentId),
					worktreeKey,
				)
				ctx.ui.notify(`Removed worktree ${worktreeKey}`, "info")
				return
			}
			if (parsed.command === "grep") {
				const query = parsed.text?.trim() || ""
				if (!query) {
					ctx.ui.notify(
						"Usage: /memory grep <query>  (use it like ripgrep: plain text or regex query)",
						"warning",
					)
					return
				}
				const paths = await resolveReadPaths(pi, ctx, currentAgentId)
				ctx.ui.notify(await grepMemoryInPaths(pi, paths, query, 50), "info")
				return
			}
			ctx.ui.notify(
				"Usage: /memory <list|recent|show|history|grep|update|delete|sync|sync-strategy|worktrees>",
				"warning",
			)
		},
	})

	pi.registerCommand("agents", {
		description: "List, add, or switch Pietta agents",
		getArgumentCompletions: getAgentsCommandCompletions,
		handler: async (args, ctx) => {
			await syncState()
			const parsed = parseAgentsArgs(args)
			if (parsed.command === "add" && parsed.value) {
				const agentId = sanitizeAgentId(parsed.value)
				await ensureAgentLayout(pi, ctx.cwd, agentId)
				ctx.ui.notify(`Created agent ${agentId}`, "info")
				return
			}
			if (
				(parsed.command === "use" || parsed.command === "switch") &&
				parsed.value
			) {
				const agentId = sanitizeAgentId(parsed.value)
				await ensureAgentLayout(pi, ctx.cwd, agentId)
				await setCurrentAgent(agentId)
				ctx.ui.setStatus(
					EXTENSION_NAME,
					ctx.ui.theme.fg("accent", `pietta:${agentId}`),
				)
				ctx.ui.notify(`Switched Pietta agent to ${agentId}`, "info")
				return
			}
			const entries = getAgentIds()
			ctx.ui.notify(
				entries.length > 0
					? `Current agent: ${getCurrentAgentId()}\n\nAgents:\n${entries.map((entry) => `${entry === getCurrentAgentId() ? "*" : "-"} ${entry}`).join("\n")}`
					: `Current agent: ${getCurrentAgentId()}\n\nNo other agents yet`,
				"info",
			)
		},
	})

	return {
		deleteSessionWorktreeForAgent: async (
			ctx: Parameters<typeof deleteSessionWorktreeForAgent>[1],
		) => {
			const failures: Array<{ agentId: string; message: string }> = []
			for (const agentId of new Set([...getAgentIds(), getCurrentAgentId()])) {
				try {
					await deleteSessionWorktreeForAgent(pi, ctx, agentId)
				} catch (error) {
					failures.push({
						agentId,
						message: error instanceof Error ? error.message : String(error),
					})
				}
			}
			return failures
		},
	}
}
