import { rm } from "node:fs/promises"
import { realpathSync } from "node:fs"
import path from "node:path"
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent"
import {
	exists,
	getCanonicalWorkTree,
	getPaths,
	getSessionWorktreeKey,
	getWorktreeBranchName,
} from "./paths.js"
import {
	WORKTREE_REGISTRATION_RETRIES,
	type GitResult,
	type MemoryPaths,
	type SyncConflictStrategy,
} from "./types.js"

export async function git(
	pi: ExtensionAPI,
	args: string[],
	options?: { cwd?: string },
): Promise<GitResult> {
	return pi.exec("git", args, options)
}

export function formatGitCommand(args: string[]): string {
	return `git ${args.join(" ")}`
}

export function getGitFailureMessage(
	action: string,
	args: string[],
	result: GitResult,
): string {
	const details = [result.stderr.trim(), result.stdout.trim()]
		.filter(Boolean)
		.join("\n")
	return [
		action,
		`command: ${formatGitCommand(args)}`,
		`exit_code: ${result.code}`,
		details || "<no output>",
	].join("\n")
}

export async function gitOrThrow(
	pi: ExtensionAPI,
	args: string[],
	action: string,
	options?: { cwd?: string },
): Promise<GitResult> {
	const result = await git(pi, args, options)
	if (result.code === 0) return result
	throw new Error(getGitFailureMessage(action, args, result))
}

export async function ensureGitIdentity(
	pi: ExtensionAPI,
	workTree: string,
): Promise<void> {
	for (const [key, fallback] of [
		["user.name", "Pietta"],
		["user.email", "pietta@local"],
	] as const) {
		const current = (
			await git(pi, ["config", "--get", key], { cwd: workTree }).catch(() => ({
				stdout: "",
				stderr: "",
				code: 1,
				killed: false,
			}))
		).stdout.trim()
		if (current) continue
		await gitOrThrow(
			pi,
			["config", key, fallback],
			`Failed to configure git identity ${key} for ${workTree}`,
			{ cwd: workTree },
		)
	}
}

export async function hasGitHead(
	pi: ExtensionAPI,
	workTree: string,
): Promise<boolean> {
	const result = await git(pi, ["rev-parse", "--verify", "HEAD"], {
		cwd: workTree,
	})
	return result.code === 0
}

export async function getCurrentBranch(
	pi: ExtensionAPI,
	workTree: string,
): Promise<string> {
	const result = await git(pi, ["branch", "--show-current"], { cwd: workTree })
	const branch = result.stdout.trim()
	if (!branch)
		throw new Error(`Could not determine current git branch for ${workTree}`)
	return branch
}

export function getLocalBranchRef(branch: string): string {
	return `refs/heads/${branch}`
}

export async function gitLocalBranchExists(
	pi: ExtensionAPI,
	workTree: string,
	branch: string,
): Promise<boolean> {
	const result = await git(
		pi,
		["show-ref", "--verify", "--quiet", getLocalBranchRef(branch)],
		{ cwd: workTree },
	)
	return result.code === 0
}

export async function getHeadCommit(
	pi: ExtensionAPI,
	workTree: string,
): Promise<string> {
	const result = await gitOrThrow(
		pi,
		["rev-parse", "HEAD"],
		`Failed to resolve HEAD for ${workTree}`,
		{ cwd: workTree },
	)
	return result.stdout.trim()
}

export async function isAncestorCommit(
	pi: ExtensionAPI,
	workTree: string,
	ancestor: string,
	descendant: string,
): Promise<boolean> {
	const args = ["merge-base", "--is-ancestor", ancestor, descendant]
	const result = await git(pi, args, { cwd: workTree })
	if (result.code === 0) return true
	if (result.code === 1) return false
	throw new Error(
		getGitFailureMessage(
			`Failed to compare git ancestry in ${workTree}`,
			args,
			result,
		),
	)
}

export async function listGitRemotes(
	pi: ExtensionAPI,
	workTree: string,
): Promise<string[]> {
	const result = await gitOrThrow(
		pi,
		["remote"],
		`Failed to list git remotes for ${workTree}`,
		{ cwd: workTree },
	)
	return result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
}

export function getRemoteTrackingRef(remote: string, branch: string): string {
	return `refs/remotes/${remote}/${branch}`
}

export async function gitRemoteTrackingBranchExists(
	pi: ExtensionAPI,
	workTree: string,
	remote: string,
	branch: string,
): Promise<boolean> {
	const result = await git(
		pi,
		["show-ref", "--verify", "--quiet", getRemoteTrackingRef(remote, branch)],
		{ cwd: workTree },
	)
	return result.code === 0
}

export async function fetchRemoteBranch(
	pi: ExtensionAPI,
	workTree: string,
	remote: string,
	branch: string,
): Promise<void> {
	const args = ["fetch", remote, branch]
	const result = await git(pi, args, { cwd: workTree })
	if (
		result.code !== 0 &&
		(await gitRemoteTrackingBranchExists(pi, workTree, remote, branch))
	)
		throw new Error(
			getGitFailureMessage(
				`Failed to fetch ${remote}/${branch} for ${workTree}`,
				args,
				result,
			),
		)
}

export async function mergeRemoteTrackingBranch(
	pi: ExtensionAPI,
	workTree: string,
	remote: string,
	branch: string,
	strategy: SyncConflictStrategy = "theirs",
): Promise<void> {
	if (!(await gitRemoteTrackingBranchExists(pi, workTree, remote, branch)))
		return
	const trackingBranch = `${remote}/${branch}`
	const args = ["merge", "--no-edit", "-X", strategy, trackingBranch]
	const result = await git(pi, args, { cwd: workTree })
	if (result.code === 0) return
	await git(pi, ["merge", "--abort"], { cwd: workTree }).catch(() => ({
		stdout: "",
		stderr: "",
		code: 1,
		killed: false,
	}))
	throw new Error(
		getGitFailureMessage(
			`Failed to merge ${trackingBranch} into ${workTree} with -X ${strategy}`,
			args,
			result,
		),
	)
}

export async function fetchCanonicalBranchFromGitRemotes(
	pi: ExtensionAPI,
	paths: MemoryPaths,
): Promise<void> {
	const canonicalWorkTree = getCanonicalWorkTree(paths)
	const canonicalBranch = await getCurrentBranch(pi, canonicalWorkTree)
	const remotes = await listGitRemotes(pi, canonicalWorkTree)
	for (const remote of remotes) {
		await fetchRemoteBranch(pi, canonicalWorkTree, remote, canonicalBranch)
	}
}

export async function fastForwardCanonicalBranchFromFetchedOrigin(
	pi: ExtensionAPI,
	paths: MemoryPaths,
): Promise<void> {
	const canonicalWorkTree = getCanonicalWorkTree(paths)
	const canonicalBranch = await getCurrentBranch(pi, canonicalWorkTree)
	if (
		!(await gitRemoteTrackingBranchExists(
			pi,
			canonicalWorkTree,
			"origin",
			canonicalBranch,
		))
	)
		return
	const divergence = await getBranchDivergence(
		pi,
		canonicalWorkTree,
		canonicalBranch,
		`origin/${canonicalBranch}`,
	)
	if (!divergence) return
	if (divergence.ahead > 0) return
	if (divergence.behind === 0) return
	await gitOrThrow(
		pi,
		["merge", "--ff-only", `origin/${canonicalBranch}`],
		`Failed to fast-forward canonical memory branch from origin/${canonicalBranch}`,
		{ cwd: canonicalWorkTree },
	)
}

export async function reconcileCanonicalBranchWithGitRemotes(
	pi: ExtensionAPI,
	paths: MemoryPaths,
): Promise<void> {
	const canonicalWorkTree = getCanonicalWorkTree(paths)
	const canonicalBranch = await getCurrentBranch(pi, canonicalWorkTree)
	const remotes = await listGitRemotes(pi, canonicalWorkTree)
	const strategy = await getConflictResolutionStrategy(pi, canonicalWorkTree)
	await fetchCanonicalBranchFromGitRemotes(pi, paths)
	for (const remote of remotes) {
		await mergeRemoteTrackingBranch(
			pi,
			canonicalWorkTree,
			remote,
			canonicalBranch,
			strategy,
		)
	}
}

export async function pushCanonicalBranchToRemote(
	pi: ExtensionAPI,
	workTree: string,
	remote: string,
	branch: string,
): Promise<void> {
	const args = ["push", remote, branch]
	const result = await git(pi, args, { cwd: workTree })
	if (result.code === 0) return
	const output = `${result.stderr}\n${result.stdout}`
	if (!/rejected|fetch first|non-fast-forward/i.test(output))
		throw new Error(
			getGitFailureMessage(
				`Failed to push ${branch} to ${remote}`,
				args,
				result,
			),
		)
	const strategy = await getConflictResolutionStrategy(pi, workTree)
	await fetchRemoteBranch(pi, workTree, remote, branch)
	await mergeRemoteTrackingBranch(pi, workTree, remote, branch, strategy)
	await gitOrThrow(
		pi,
		args,
		`Failed to push ${branch} to ${remote} after auto-merging remote changes`,
		{ cwd: workTree },
	)
}

export async function getConflictResolutionStrategy(
	pi: ExtensionAPI,
	workTree: string,
): Promise<SyncConflictStrategy> {
	const result = await git(pi, ["config", "--get", "pietta.syncStrategy"], {
		cwd: workTree,
	})
	const value = result.stdout.trim()
	return value === "ours" ? "ours" : "theirs"
}

export async function setConflictResolutionStrategy(
	pi: ExtensionAPI,
	workTree: string,
	strategy: SyncConflictStrategy,
): Promise<void> {
	await gitOrThrow(
		pi,
		["config", "pietta.syncStrategy", strategy],
		`Failed to set Pietta sync strategy to ${strategy} for ${workTree}`,
		{ cwd: workTree },
	)
}

export async function getRemoteUrl(
	pi: ExtensionAPI,
	workTree: string,
	remote: string,
): Promise<string | null> {
	const result = await git(pi, ["remote", "get-url", remote], { cwd: workTree })
	return result.code === 0 ? result.stdout.trim() || null : null
}

export async function getBranchDivergence(
	pi: ExtensionAPI,
	workTree: string,
	localRef: string,
	remoteRef: string,
): Promise<{ ahead: number; behind: number } | null> {
	const args = [
		"rev-list",
		"--left-right",
		"--count",
		`${localRef}...${remoteRef}`,
	]
	const result = await git(pi, args, { cwd: workTree })
	if (result.code !== 0) return null
	const [aheadRaw = "0", behindRaw = "0"] = result.stdout.trim().split(/\s+/)
	const ahead = Number.parseInt(aheadRaw, 10)
	const behind = Number.parseInt(behindRaw, 10)
	return {
		ahead: Number.isFinite(ahead) ? ahead : 0,
		behind: Number.isFinite(behind) ? behind : 0,
	}
}

export async function renderSyncStatus(
	pi: ExtensionAPI,
	paths: MemoryPaths,
): Promise<string[]> {
	const canonicalWorkTree = getCanonicalWorkTree(paths)
	const canonicalBranch = await getCurrentBranch(pi, canonicalWorkTree)
	const strategy = await getConflictResolutionStrategy(pi, canonicalWorkTree)
	const remotes = await listGitRemotes(pi, canonicalWorkTree)
	if (remotes.length === 0)
		return [`Sync strategy: ${strategy}`, "Git remotes: none"]
	const lines = [
		`Sync strategy: ${strategy}`,
		`Git remotes: ${remotes.length}`,
		"Remote sync status:",
	]
	for (const remote of remotes) {
		const url = await getRemoteUrl(pi, canonicalWorkTree, remote)
		const trackingExists = await gitRemoteTrackingBranchExists(
			pi,
			canonicalWorkTree,
			remote,
			canonicalBranch,
		)
		if (!trackingExists) {
			lines.push(
				`- ${remote}: branch ${canonicalBranch} not found${url ? ` (${url})` : ""}`,
			)
			continue
		}
		const divergence = await getBranchDivergence(
			pi,
			canonicalWorkTree,
			canonicalBranch,
			`${remote}/${canonicalBranch}`,
		)
		lines.push(
			`- ${remote}: ahead ${divergence?.ahead ?? 0}, behind ${divergence?.behind ?? 0}${url ? ` (${url})` : ""}`,
		)
	}
	return lines
}

export async function syncWorktreeWithCanonical(
	pi: ExtensionAPI,
	paths: MemoryPaths,
	worktreeKey: string,
): Promise<void> {
	const branch = getWorktreeBranchName(worktreeKey)
	if (!branch) return
	const canonicalWorkTree = getCanonicalWorkTree(paths)
	const canonicalBranch = await getCurrentBranch(pi, canonicalWorkTree)
	const hasChanges = await hasGitChanges(pi, paths.workTree)
	if (hasChanges)
		throw new Error(
			`Cannot sync session worktree ${branch} because it has uncommitted changes`,
		)
	await reconcileCanonicalBranchWithGitRemotes(pi, paths)
	await gitOrThrow(
		pi,
		["reset", "--hard", canonicalBranch],
		`Failed to reset session worktree ${branch} onto ${canonicalBranch}`,
		{ cwd: paths.workTree },
	)
	await gitOrThrow(
		pi,
		["clean", "-fd"],
		`Failed to clean session worktree ${branch}`,
		{ cwd: paths.workTree },
	)
	await gitOrThrow(
		pi,
		["rebase", canonicalBranch],
		`Failed to rebase session worktree ${branch} onto ${canonicalBranch}`,
		{ cwd: paths.workTree },
	)
}

export async function fastForwardCanonicalBranch(
	pi: ExtensionAPI,
	paths: MemoryPaths,
	worktreeKey: string,
): Promise<void> {
	const branch = getWorktreeBranchName(worktreeKey)
	if (!branch) return
	const canonicalWorkTree = getCanonicalWorkTree(paths)
	const canonicalBranch = await getCurrentBranch(pi, canonicalWorkTree)
	await reconcileCanonicalBranchWithGitRemotes(pi, paths)
	await gitOrThrow(
		pi,
		["rebase", canonicalBranch],
		`Failed to rebase session worktree ${branch} onto latest ${canonicalBranch}`,
		{ cwd: paths.workTree },
	)
	const canonicalHead = await getHeadCommit(pi, canonicalWorkTree)
	const sessionHead = await getHeadCommit(pi, paths.workTree)
	if (
		!(await isAncestorCommit(pi, canonicalWorkTree, canonicalHead, sessionHead))
	)
		throw new Error(
			`Session worktree ${branch} is not based on canonical branch ${canonicalBranch} after rebase`,
		)
	await gitOrThrow(
		pi,
		["merge", "--ff-only", branch],
		`Failed to fast-forward canonical memory branch from ${branch}`,
		{ cwd: canonicalWorkTree },
	)
}

export async function syncCanonicalBranchFromBare(
	pi: ExtensionAPI,
	paths: MemoryPaths,
): Promise<void> {
	await fetchCanonicalBranchFromGitRemotes(pi, paths)
	await fastForwardCanonicalBranchFromFetchedOrigin(pi, paths)
}

export async function pushCanonicalBranchToBare(
	pi: ExtensionAPI,
	paths: MemoryPaths,
): Promise<void> {
	const canonicalWorkTree = getCanonicalWorkTree(paths)
	const canonicalBranch = await getCurrentBranch(pi, canonicalWorkTree)
	const remotes = await listGitRemotes(pi, canonicalWorkTree)
	for (const remote of remotes) {
		await pushCanonicalBranchToRemote(
			pi,
			canonicalWorkTree,
			remote,
			canonicalBranch,
		)
	}
}

export async function hasGitChanges(
	pi: ExtensionAPI,
	workTree: string,
): Promise<boolean> {
	const status = await gitOrThrow(
		pi,
		["status", "--porcelain"],
		`Failed to inspect git status for ${workTree}`,
		{ cwd: workTree },
	)
	return status.stdout.trim().length > 0
}

export async function commitWorktreeChanges(
	pi: ExtensionAPI,
	workTree: string,
	message: string,
	files?: string[],
): Promise<void> {
	const changedPaths = [...new Set((files ?? []).filter(Boolean))]
	if (changedPaths.length > 0) {
		await gitOrThrow(
			pi,
			["add", "--", ...changedPaths],
			`Failed to stage memory changes in ${workTree}`,
			{ cwd: workTree },
		)
	} else {
		await gitOrThrow(
			pi,
			["add", "-A"],
			`Failed to stage memory changes in ${workTree}`,
			{ cwd: workTree },
		)
	}
	if (!(await hasGitChanges(pi, workTree))) return
	await ensureGitIdentity(pi, workTree)
	await gitOrThrow(
		pi,
		["commit", "-m", message],
		`Failed to commit memory changes in ${workTree}`,
		{ cwd: workTree },
	)
}

export function toWorktreeRelativePaths(
	paths: MemoryPaths,
	files: string[],
): string[] {
	return files.map((file) => path.relative(paths.workTree, file))
}

export function parseWorktreeList(
	output: string,
): Array<{ path: string; branch?: string; head?: string }> {
	const worktrees: Array<{ path: string; branch?: string; head?: string }> = []
	let current: { path: string; branch?: string; head?: string } | null = null
	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) {
			if (current) worktrees.push(current)
			current = null
			continue
		}
		const [key, ...rest] = line.split(" ")
		const value = rest.join(" ").trim()
		if (key === "worktree") {
			if (current) worktrees.push(current)
			current = { path: value }
			continue
		}
		if (!current) continue
		if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "")
		if (key === "HEAD") current.head = value
	}
	if (current) worktrees.push(current)
	return worktrees
}

export async function listMemoryWorktrees(
	pi: ExtensionAPI,
	paths: MemoryPaths,
): Promise<Array<{ path: string; branch?: string; head?: string }>> {
	const canonicalWorkTree = getCanonicalWorkTree(paths)
	if (!(await exists(canonicalWorkTree))) return []
	const result = await gitOrThrow(
		pi,
		["worktree", "list", "--porcelain"],
		`Failed to list memory worktrees for ${canonicalWorkTree}`,
		{ cwd: canonicalWorkTree },
	)
	return parseWorktreeList(result.stdout)
}

export async function hasGitWorkTreeFile(workTree: string): Promise<boolean> {
	return exists(path.join(workTree, ".git"))
}

export function normalizePathForCompare(filePath: string): string {
	try {
		return realpathSync(filePath)
	} catch {
		return path.resolve(filePath)
	}
}

export async function isRegisteredWorktree(
	pi: ExtensionAPI,
	paths: MemoryPaths,
	workTree: string,
	branch?: string | null,
): Promise<boolean> {
	const target = normalizePathForCompare(workTree)
	const worktrees = await listMemoryWorktrees(pi, paths)
	return worktrees.some(
		(entry) =>
			normalizePathForCompare(entry.path) === target ||
			(branch != null && entry.branch === branch),
	)
}

export async function waitForRegisteredWorktree(
	pi: ExtensionAPI,
	paths: MemoryPaths,
	workTree: string,
	branch?: string | null,
): Promise<boolean> {
	for (let attempt = 0; attempt < WORKTREE_REGISTRATION_RETRIES; attempt++) {
		if (
			(await hasGitWorkTreeFile(workTree)) &&
			(await isRegisteredWorktree(pi, paths, workTree, branch))
		)
			return true
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	return false
}

export async function getWorktreeDebugInfo(
	pi: ExtensionAPI,
	paths: MemoryPaths,
	workTree: string,
	branch?: string | null,
	lastAdd?: { stdout: string; stderr: string } | null,
): Promise<string> {
	const canonicalWorkTree = getCanonicalWorkTree(paths)
	const [worktreeList, branchList] = await Promise.all([
		git(pi, ["worktree", "list", "--porcelain"], {
			cwd: canonicalWorkTree,
		}).catch((error) => ({
			stdout: "",
			stderr: String(error),
			code: 1,
			killed: false,
		})),
		git(pi, ["branch", "-a", "-vv"], { cwd: canonicalWorkTree }).catch(
			(error) => ({
				stdout: "",
				stderr: String(error),
				code: 1,
				killed: false,
			}),
		),
	])
	return [
		`target_worktree: ${workTree}`,
		`canonical_worktree: ${canonicalWorkTree}`,
		`branch: ${branch ?? "<none>"}`,
		"last_add_stderr:",
		lastAdd?.stderr.trim() || "<empty>",
		"worktree_list:",
		worktreeList.stdout.trim() || worktreeList.stderr.trim() || "<empty>",
		"branch_list:",
		branchList.stdout.trim() || branchList.stderr.trim() || "<empty>",
	].join("\n")
}

export async function ensureMemoryWorktree(
	pi: ExtensionAPI,
	cwd: string,
	paths: MemoryPaths,
	worktreeKey: string,
	created: string[],
): Promise<MemoryPaths> {
	if (worktreeKey === "main") return paths
	const workTree = path.join(paths.worktreesDir, worktreeKey)
	const branch = getWorktreeBranchName(worktreeKey)
	const canonicalBranch = await getCurrentBranch(pi, paths.workTree)
	let lastAdd: { stdout: string; stderr: string } | null = null

	if (
		(await exists(workTree)) &&
		(!(await hasGitWorkTreeFile(workTree)) ||
			!(await isRegisteredWorktree(pi, paths, workTree, branch)))
	) {
		await rm(workTree, { recursive: true, force: true })
	}
	if (!(await exists(workTree))) {
		const pruneResult = await git(pi, ["worktree", "prune"], {
			cwd: paths.workTree,
		})
		if (pruneResult.code !== 0)
			throw new Error(
				getGitFailureMessage(
					`Failed to prune stale memory worktrees for ${paths.workTree}`,
					["worktree", "prune"],
					pruneResult,
				),
			)
		if (branch && (await gitLocalBranchExists(pi, paths.workTree, branch))) {
			lastAdd = await gitOrThrow(
				pi,
				["worktree", "add", "--force", workTree, branch],
				`Failed to attach existing memory worktree branch ${branch}`,
				{ cwd: paths.workTree },
			)
		} else if (branch) {
			lastAdd = await gitOrThrow(
				pi,
				["worktree", "add", "--force", "-b", branch, workTree, canonicalBranch],
				`Failed to create memory worktree branch ${branch}`,
				{ cwd: paths.workTree },
			)
		} else {
			lastAdd = await gitOrThrow(
				pi,
				["worktree", "add", "--force", workTree, canonicalBranch],
				`Failed to attach memory worktree ${workTree}`,
				{ cwd: paths.workTree },
			)
		}
		created.push(workTree)
	}
	if (!(await waitForRegisteredWorktree(pi, paths, workTree, branch))) {
		const debug = await getWorktreeDebugInfo(
			pi,
			paths,
			workTree,
			branch,
			lastAdd,
		)
		await rm(workTree, { recursive: true, force: true })
		throw new Error(
			`Failed to create registered git worktree at ${workTree} for ${branch ?? canonicalBranch}\n\n${debug}`,
		)
	}
	await ensureGitIdentity(pi, workTree)
	return getPaths(cwd, path.basename(paths.agentDir), workTree)
}

export async function deleteMemoryWorktree(
	pi: ExtensionAPI,
	paths: MemoryPaths,
	worktreeKey: string,
): Promise<void> {
	if (worktreeKey === "main")
		throw new Error("The main worktree cannot be removed")
	const workTree = path.join(paths.worktreesDir, worktreeKey)
	const branch = getWorktreeBranchName(worktreeKey)
	if (await exists(workTree))
		await gitOrThrow(
			pi,
			["worktree", "remove", "--force", workTree],
			`Failed to remove memory worktree ${workTree}`,
			{ cwd: paths.workTree },
		)
	if (branch && (await gitLocalBranchExists(pi, paths.workTree, branch)))
		await gitOrThrow(
			pi,
			["branch", "-D", branch],
			`Failed to delete memory worktree branch ${branch}`,
			{ cwd: paths.workTree },
		)
}

export async function deleteSessionWorktreeForAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
): Promise<void> {
	const worktreeKey = getSessionWorktreeKey(ctx)
	if (worktreeKey === "main") return
	const paths = getPaths(ctx.cwd, agentId)
	const workTree = path.join(paths.worktreesDir, worktreeKey)
	const branch = getWorktreeBranchName(worktreeKey)
	if (!(await exists(paths.workTree))) return
	if (
		!(await exists(workTree)) &&
		!(branch && (await gitLocalBranchExists(pi, paths.workTree, branch)))
	)
		return
	await deleteMemoryWorktree(pi, paths, worktreeKey)
}
