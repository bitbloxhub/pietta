import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent"
import {
	commitWorktreeChanges,
	ensureGitIdentity,
	ensureMemoryWorktree,
	hasGitChanges,
	hasGitHead,
	hasGitWorkTreeFile,
	pushCanonicalBranchToBare,
	syncCanonicalBranchFromBare,
	syncWorktreeWithCanonical,
	gitOrThrow,
} from "./git.js"
import {
	exists,
	getPaths,
	getProjectSlug,
	getSessionWorktreeKey,
} from "./paths.js"
import type { EnsureResult, MemoryPaths, MutationPathsResult } from "./types.js"

export async function ensureDir(dir: string, created: string[]): Promise<void> {
	if (await exists(dir)) return
	await mkdir(dir, { recursive: true })
	created.push(dir)
}
export async function ensureFile(
	filePath: string,
	content: string,
	created: string[],
): Promise<void> {
	if (await exists(filePath)) return
	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, content, "utf8")
	created.push(filePath)
}
export function getDefaultFiles(
	cwd: string,
	agentId: string,
	paths: MemoryPaths,
): Record<string, string> {
	const projectSlug = getProjectSlug(cwd)
	const now = new Date().toISOString()
	return {
		[path.join(paths.workTree, "README.md")]:
			`# Pietta Memory\n\nThis git-backed worktree stores durable memory for agent \`${agentId}\`.\n\n## Hierarchy\n\n- \`system/\` is pinned high-priority memory, but Pietta does not prescribe fixed subfolders inside it\n- \`projects/<slug>/\` is project-scoped memory, and Pietta does not prescribe fixed subfolders there either\n- \`sessions/\`, \`rules/\`, and \`archive/\` hold supporting memory and maintenance data\n`,
		[path.join(paths.systemDir, "README.md")]:
			`# System Memory\n\nPinned high-priority memory. Organize this however the agent decides.\n`,
		[path.join(paths.projectSystemDir, "README.md")]:
			`# Project System Memory\n\nPinned high-priority memory for this project. Organize this however the agent decides.\n`,
		[paths.projectSummaryFile]: `# ${projectSlug}\n\nProject-scoped memory. Organize this however the agent decides.\n\n- Initialized: ${now}\n- Agent: ${agentId}\n`,
		[paths.timelineFile]: "",
		[paths.latestSummaryFile]: `# Latest Summary\n\nNo generated summary yet.\n`,
		[path.join(paths.projectRulesDir, "README.md")]: "# Project Rules\n\n",
		[path.join(paths.agentRulesDir, "README.md")]: "# Agent Rules\n\n",
		[path.join(paths.generatedRulesDir, "README.md")]: "# Generated Rules\n\n",
	}
}

export function getManagedDirectories(paths: MemoryPaths): string[] {
	return [
		paths.root,
		paths.agentsDir,
		paths.agentDir,
		paths.worktreesDir,
		paths.systemDir,
		paths.projectsDir,
		paths.projectSystemDir,
		paths.projectDir,
		paths.sessionsDir,
		paths.sessionMemoryDir,
		paths.summariesDir,
		paths.archiveDir,
		paths.rulesDir,
		paths.projectRulesDir,
		paths.agentRulesDir,
		paths.generatedRulesDir,
	]
}

export async function ensureAgentLayout(
	pi: ExtensionAPI,
	cwd: string,
	agentId: string,
	worktreeKey: string = "main",
): Promise<EnsureResult> {
	const basePaths = getPaths(cwd, agentId)
	const created: string[] = []
	for (const dir of [
		basePaths.root,
		basePaths.agentsDir,
		basePaths.agentDir,
		basePaths.worktreesDir,
	]) {
		await ensureDir(dir, created)
	}
	if (!(await exists(basePaths.bareRepo))) {
		await gitOrThrow(
			pi,
			["init", "--bare", "--initial-branch=main", basePaths.bareRepo],
			`Failed to initialize bare memory repo ${basePaths.bareRepo}`,
		)
		created.push(basePaths.bareRepo)
	}
	if (!(await exists(basePaths.workTree))) {
		await gitOrThrow(
			pi,
			["clone", basePaths.bareRepo, basePaths.workTree],
			`Failed to clone memory repo into ${basePaths.workTree}`,
			{ cwd },
		)
		created.push(basePaths.workTree)
	}
	await ensureGitIdentity(pi, basePaths.workTree)
	await syncCanonicalBranchFromBare(pi, basePaths)
	for (const dir of getManagedDirectories(basePaths)) {
		await ensureDir(dir, created)
	}
	for (const [filePath, content] of Object.entries(
		getDefaultFiles(cwd, agentId, basePaths),
	)) {
		await ensureFile(filePath, content, created)
	}

	if (
		!(await hasGitHead(pi, basePaths.workTree)) ||
		(await hasGitChanges(pi, basePaths.workTree))
	) {
		await commitWorktreeChanges(
			pi,
			basePaths.workTree,
			"chore(memory): initialize repo",
		)
		await pushCanonicalBranchToBare(pi, basePaths)
	}
	const paths = await ensureMemoryWorktree(
		pi,
		cwd,
		basePaths,
		worktreeKey,
		created,
	)
	return { paths, created }
}
export async function ensureWorktreeLayout(
	cwd: string,
	agentId: string,
	paths: MemoryPaths,
): Promise<void> {
	if (!(await hasGitWorkTreeFile(paths.workTree))) {
		throw new Error(`Refusing to populate non-git worktree: ${paths.workTree}`)
	}
	for (const dir of getManagedDirectories(paths)) {
		await mkdir(dir, { recursive: true })
	}
	for (const [filePath, content] of Object.entries(
		getDefaultFiles(cwd, agentId, paths),
	)) {
		if (await exists(filePath)) continue
		await mkdir(path.dirname(filePath), { recursive: true })
		await writeFile(filePath, content, "utf8")
	}
}
export async function resolveMutationPaths(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
): Promise<MutationPathsResult> {
	const sessionId = ctx.sessionManager.getSessionId().trim()
	const sessionFile = ctx.sessionManager.getSessionFile()
	const source = sessionFile || sessionId || "ephemeral"
	const worktreeKey = getSessionWorktreeKey(ctx)
	const { paths } = await ensureAgentLayout(pi, ctx.cwd, agentId, worktreeKey)
	await syncWorktreeWithCanonical(pi, paths, worktreeKey)
	await ensureWorktreeLayout(ctx.cwd, agentId, paths)
	return { paths, worktreeKey, source }
}
export async function resolveReadPaths(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
): Promise<MemoryPaths> {
	const worktreeKey = getSessionWorktreeKey(ctx)
	const { paths } = await ensureAgentLayout(pi, ctx.cwd, agentId, worktreeKey)
	await syncWorktreeWithCanonical(pi, paths, worktreeKey)
	await ensureWorktreeLayout(ctx.cwd, agentId, paths)
	return paths
}
