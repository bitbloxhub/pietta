import { access } from "node:fs/promises"
import { constants, realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { ExtensionContext } from "@mariozechner/pi-coding-agent"
import { DEFAULT_AGENT_ID, type MemoryPaths } from "./types.js"

export function getStorageRoot(): string {
	try {
		return path.join(realpathSync(homedir()), ".pi", "pietta")
	} catch {
		return path.join(homedir(), ".pi", "pietta")
	}
}

export function sanitizeAgentId(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || DEFAULT_AGENT_ID
	)
}

export function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "project"
	)
}

export function getProjectSlug(cwd: string): string {
	return slugify(path.basename(cwd))
}

export function slugifyMemoryName(value: string): string {
	return (
		value
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^\p{L}\p{N}\s-]+/gu, " ")
			.replace(/[-\s]+/g, "_")
			.replace(/^_+|_+$/g, "") || "memory_entry"
	)
}

export function getPaths(
	cwd: string,
	agentId: string,
	workTreeOverride?: string,
): MemoryPaths {
	const root = getStorageRoot()
	const agentsDir = path.join(root, "agents")
	const agentDir = path.join(agentsDir, agentId)
	const mainWorkTree = path.join(agentDir, "memory")
	const workTree = workTreeOverride ?? mainWorkTree
	const projectDir = path.join(workTree, "projects", getProjectSlug(cwd))
	const rulesDir = path.join(workTree, "rules")

	return {
		root,
		stateFile: path.join(root, "state.json"),
		agentsDir,
		agentDir,
		bareRepo: path.join(agentDir, "memory.git"),
		workTree,
		worktreesDir: path.join(agentDir, "worktrees"),
		profileDir: path.join(workTree, "profile"),
		projectDir,
		projectFactsDir: path.join(projectDir, "facts"),
		projectSummaryFile: path.join(projectDir, "SUMMARY.md"),
		projectDecisionsFile: path.join(projectDir, "decisions.md"),
		timelineFile: path.join(projectDir, "timeline.jsonl"),
		scratchpadFile: path.join(projectDir, "scratchpad.md"),
		sessionsDir: path.join(workTree, "sessions"),
		sessionMemoryDir: path.join(workTree, "sessions", "memory"),
		summariesDir: path.join(workTree, "summaries"),
		latestSummaryFile: path.join(workTree, "summaries", "latest.md"),
		inboxDir: path.join(workTree, "inbox"),
		candidatesFile: path.join(workTree, "inbox", "candidates.jsonl"),
		rulesDir,
		projectRulesDir: path.join(rulesDir, "project"),
		agentRulesDir: path.join(rulesDir, "agent"),
		generatedRulesDir: path.join(rulesDir, "generated"),
		agentNotesDir: path.join(workTree, "agent"),
	}
}

export async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK)
		return true
	} catch {
		return false
	}
}

export function slugifyWorktreeKey(value: string): string {
	return slugify(value).replace(/^-+|-+$/g, "") || "main"
}

export function getSessionWorktreeKey(ctx: ExtensionContext): string {
	const sessionId = ctx.sessionManager.getSessionId().trim()
	if (sessionId) return `session_${slugifyWorktreeKey(sessionId)}`
	const sessionFile = ctx.sessionManager.getSessionFile()
	if (!sessionFile) return "main"
	const parsed = path.parse(sessionFile)
	return `session_${slugifyWorktreeKey(parsed.name || parsed.base || sessionFile)}`
}

export function getWorktreeBranchName(worktreeKey: string): string | null {
	if (worktreeKey === "main") return null
	return `pietta/session/${worktreeKey}`
}

export function getCanonicalWorkTree(paths: MemoryPaths): string {
	return path.join(paths.agentDir, "memory")
}
