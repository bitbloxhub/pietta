import {
	access,
	appendFile,
	mkdir,
	readdir,
	readFile,
	stat,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises"
import {
	constants,
	existsSync,
	readFileSync,
	readdirSync,
	realpathSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { StringEnum } from "@mariozechner/pi-ai"
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent"
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent"
import type { AutocompleteItem } from "@mariozechner/pi-tui"
import { Type } from "@sinclair/typebox"
type Scope = "project" | "agent" | "session"
type PiettaState = {
	currentAgentId: string
}
type MemoryPaths = {
	root: string
	stateFile: string
	agentsDir: string
	agentDir: string
	bareRepo: string
	workTree: string
	worktreesDir: string
	profileDir: string
	projectDir: string
	projectFactsDir: string
	projectSummaryFile: string
	projectDecisionsFile: string
	timelineFile: string
	scratchpadFile: string
	sessionsDir: string
	sessionMemoryDir: string
	summariesDir: string
	latestSummaryFile: string
	inboxDir: string
	candidatesFile: string
	rulesDir: string
	projectRulesDir: string
	agentRulesDir: string
	generatedRulesDir: string
	agentNotesDir: string
}
type EnsureResult = {
	paths: MemoryPaths
	created: string[]
}
type RememberInput = {
	text: string
	scope: Scope
	kind: string
	confidence: number
	source?: string
}
type MemoryItem = {
	id: string
	filePath: string
	scope: Scope
	kind: string
	createdAt?: string
	updatedAt?: string
	sources: string[]
	body: string
}
const EXTENSION_NAME = "pietta"
const DEFAULT_AGENT_ID = "default"
const SCOPE_VALUES = ["project", "agent", "session"] as const
const WORKTREE_REGISTRATION_RETRIES = 5
type GitResult = {
	stdout: string
	stderr: string
	code: number
	killed: boolean
}
type SyncConflictStrategy = "ours" | "theirs"

function getStorageRoot(): string {
	try {
		return path.join(realpathSync(homedir()), ".pi", "pietta")
	} catch {
		return path.join(homedir(), ".pi", "pietta")
	}
}
function sanitizeAgentId(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || DEFAULT_AGENT_ID
	)
}
function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "project"
	)
}
function getProjectSlug(cwd: string): string {
	return slugify(path.basename(cwd))
}
function slugifyMemoryName(value: string): string {
	return (
		value
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^\p{L}\p{N}\s-]+/gu, " ")
			.replace(/[-\s]+/g, "_")
			.replace(/^_+|_+$/g, "") || "memory_entry"
	)
}
function getPaths(
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
async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK)
		return true
	} catch {
		return false
	}
}
async function ensureDir(dir: string, created: string[]): Promise<void> {
	if (await exists(dir)) return
	await mkdir(dir, { recursive: true })
	created.push(dir)
}
async function ensureFile(
	filePath: string,
	content: string,
	created: string[],
): Promise<void> {
	if (await exists(filePath)) return
	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, content, "utf8")
	created.push(filePath)
}
function slugifyWorktreeKey(value: string): string {
	return slugify(value).replace(/^-+|-+$/g, "") || "main"
}
function getSessionWorktreeKey(ctx: ExtensionContext): string {
	const sessionId = ctx.sessionManager.getSessionId().trim()
	if (sessionId) return `session_${slugifyWorktreeKey(sessionId)}`
	const sessionFile = ctx.sessionManager.getSessionFile()
	if (!sessionFile) return "main"
	const parsed = path.parse(sessionFile)
	return `session_${slugifyWorktreeKey(parsed.name || parsed.base || sessionFile)}`
}
function getWorktreeBranchName(worktreeKey: string): string | null {
	if (worktreeKey === "main") return null
	return `pietta/session/${worktreeKey}`
}
function getCanonicalWorkTree(paths: MemoryPaths): string {
	return path.join(paths.agentDir, "memory")
}
async function git(
	pi: ExtensionAPI,
	args: string[],
	options?: { cwd?: string },
): Promise<GitResult> {
	return pi.exec("git", args, options)
}
function formatGitCommand(args: string[]): string {
	return `git ${args.join(" ")}`
}
function getGitFailureMessage(
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
async function gitOrThrow(
	pi: ExtensionAPI,
	args: string[],
	action: string,
	options?: { cwd?: string },
): Promise<GitResult> {
	const result = await git(pi, args, options)
	if (result.code === 0) return result
	throw new Error(getGitFailureMessage(action, args, result))
}
async function ensureGitIdentity(
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
async function hasGitHead(
	pi: ExtensionAPI,
	workTree: string,
): Promise<boolean> {
	const result = await git(pi, ["rev-parse", "--verify", "HEAD"], {
		cwd: workTree,
	})
	return result.code === 0
}
async function getCurrentBranch(
	pi: ExtensionAPI,
	workTree: string,
): Promise<string> {
	const result = await git(pi, ["branch", "--show-current"], { cwd: workTree })
	const branch = result.stdout.trim()
	if (!branch)
		throw new Error(`Could not determine current git branch for ${workTree}`)
	return branch
}
function getLocalBranchRef(branch: string): string {
	return `refs/heads/${branch}`
}
async function gitLocalBranchExists(
	pi: ExtensionAPI,
	workTree: string,
	branch: string,
): Promise<boolean> {
	const result = await git(
		pi,
		["show-ref", "--verify", "--quiet", getLocalBranchRef(branch)],
		{
			cwd: workTree,
		},
	)
	return result.code === 0
}
async function getHeadCommit(
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
async function isAncestorCommit(
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
async function listGitRemotes(
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
function getRemoteTrackingRef(remote: string, branch: string): string {
	return `refs/remotes/${remote}/${branch}`
}
async function gitRemoteTrackingBranchExists(
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
async function fetchRemoteBranch(
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
async function mergeRemoteTrackingBranch(
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
async function fetchCanonicalBranchFromGitRemotes(
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
async function fastForwardCanonicalBranchFromFetchedOrigin(
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
async function reconcileCanonicalBranchWithGitRemotes(
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
async function pushCanonicalBranchToRemote(
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
async function getConflictResolutionStrategy(
	pi: ExtensionAPI,
	workTree: string,
): Promise<SyncConflictStrategy> {
	const result = await git(pi, ["config", "--get", "pietta.syncStrategy"], {
		cwd: workTree,
	})
	const value = result.stdout.trim()
	return value === "ours" ? "ours" : "theirs"
}
async function setConflictResolutionStrategy(
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
async function getRemoteUrl(
	pi: ExtensionAPI,
	workTree: string,
	remote: string,
): Promise<string | null> {
	const result = await git(pi, ["remote", "get-url", remote], { cwd: workTree })
	return result.code === 0 ? result.stdout.trim() || null : null
}
async function getBranchDivergence(
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
async function renderSyncStatus(
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

async function syncWorktreeWithCanonical(
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
async function fastForwardCanonicalBranch(
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

async function syncCanonicalBranchFromBare(
	pi: ExtensionAPI,
	paths: MemoryPaths,
): Promise<void> {
	await fetchCanonicalBranchFromGitRemotes(pi, paths)
	await fastForwardCanonicalBranchFromFetchedOrigin(pi, paths)
}
async function pushCanonicalBranchToBare(
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

async function hasGitChanges(
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
async function commitWorktreeChanges(
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
function toWorktreeRelativePaths(
	paths: MemoryPaths,
	files: string[],
): string[] {
	return files.map((file) => path.relative(paths.workTree, file))
}
function parseWorktreeList(
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
async function listMemoryWorktrees(
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
async function hasGitWorkTreeFile(workTree: string): Promise<boolean> {
	return exists(path.join(workTree, ".git"))
}

function normalizePathForCompare(filePath: string): string {
	try {
		return realpathSync(filePath)
	} catch {
		return path.resolve(filePath)
	}
}
async function isRegisteredWorktree(
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
async function waitForRegisteredWorktree(
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
async function getWorktreeDebugInfo(
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

async function ensureMemoryWorktree(
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
				{
					cwd: paths.workTree,
				},
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
				{
					cwd: paths.workTree,
				},
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
async function deleteMemoryWorktree(
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
async function deleteSessionWorktreeForAgent(
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

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T
	} catch {
		return fallback
	}
}
async function writeJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}
function getCurrentAgentIdSync(): string {
	const stateFile = path.join(getStorageRoot(), "state.json")
	if (!existsSync(stateFile)) return DEFAULT_AGENT_ID
	try {
		const state = JSON.parse(
			readFileSync(stateFile, "utf8"),
		) as Partial<PiettaState>
		return sanitizeAgentId(state.currentAgentId || DEFAULT_AGENT_ID)
	} catch {
		return DEFAULT_AGENT_ID
	}
}

async function loadState(): Promise<PiettaState> {
	return readJson<PiettaState>(path.join(getStorageRoot(), "state.json"), {
		currentAgentId: DEFAULT_AGENT_ID,
	})
}

async function saveState(state: PiettaState): Promise<void> {
	await writeJson(path.join(getStorageRoot(), "state.json"), state)
}
function getAgentIds(): string[] {
	const agentsDir = path.join(getStorageRoot(), "agents")
	if (!existsSync(agentsDir)) return []
	return readdirSync(agentsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
}
function toAutocompleteItems(
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
function getAgentsCommandCompletions(
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
function getRememberCompletions(prefix: string): AutocompleteItem[] | null {
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
function getMemoryRoots(
	paths: MemoryPaths,
): Array<{ scope: Scope; dir: string }> {
	return [
		{ scope: "project", dir: paths.projectFactsDir },
		{ scope: "agent", dir: paths.agentNotesDir },
		{ scope: "session", dir: paths.sessionMemoryDir },
	]
}
function getMemoryItemId(scope: Scope, filePath: string): string {
	return `${scope}/${path.basename(filePath, ".md")}`
}
function getMemoryItemIdsSync(cwd: string, agentId: string): string[] {
	const paths = getPaths(cwd, agentId)
	const ids = new Set<string>()
	for (const { scope, dir } of getMemoryRoots(paths)) {
		if (!existsSync(dir)) continue
		const stack = [dir]
		while (stack.length > 0) {
			const current = stack.pop()
			if (!current) continue
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				const fullPath = path.join(current, entry.name)
				if (entry.isDirectory()) {
					stack.push(fullPath)
					continue
				}
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue
				const parsed = parseFrontmatterBlock(readFileSync(fullPath, "utf8"))
				ids.add(
					typeof parsed.data.id === "string"
						? parsed.data.id
						: getMemoryItemId(scope, fullPath),
				)
			}
		}
	}
	return [...ids].sort()
}
function getMemoryWorktreeKeysSync(cwd: string, agentId: string): string[] {
	const paths = getPaths(cwd, agentId)
	const keys = new Set(["main"])
	if (!existsSync(paths.worktreesDir)) return [...keys]
	for (const entry of readdirSync(paths.worktreesDir, {
		withFileTypes: true,
	})) {
		if (!entry.isDirectory()) continue
		keys.add(entry.name)
	}
	return [...keys].sort()
}

function getMemoryCommandCompletions(
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

function frontmatter(
	fields: Record<string, string | number | string[]>,
): string {
	const lines = Object.entries(fields).flatMap(([key, value]) => {
		if (Array.isArray(value))
			return [`${key}:`, ...value.map((item) => `  - ${item}`)]
		return [`${key}: ${value}`]
	})
	return `---\n${lines.join("\n")}\n---`
}
function parseFrontmatterBlock(content: string): {
	data: Record<string, string | string[]>
	body: string
} {
	if (!content.startsWith("---\n")) return { data: {}, body: content.trim() }
	const endIndex = content.indexOf("\n---\n", 4)
	if (endIndex === -1) return { data: {}, body: content.trim() }
	const raw = content.slice(4, endIndex)
	const body = content.slice(endIndex + 5).trim()
	const data: Record<string, string | string[]> = {}
	let activeArrayKey: string | null = null

	for (const line of raw.split("\n")) {
		if (line.startsWith("  - ") && activeArrayKey) {
			const existing = data[activeArrayKey]
			if (Array.isArray(existing)) existing.push(line.slice(4))
			continue
		}
		const separatorIndex = line.indexOf(":")
		if (separatorIndex === -1) continue
		const key = line.slice(0, separatorIndex).trim()
		const value = line.slice(separatorIndex + 1).trim()
		if (!value) {
			data[key] = []
			activeArrayKey = key
			continue
		}
		data[key] = value
		activeArrayKey = null
	}

	return { data, body }
}
function getRememberDir(paths: MemoryPaths, scope: Scope): string {
	switch (scope) {
		case "project":
			return paths.projectFactsDir
		case "agent":
			return paths.agentNotesDir
		case "session":
			return paths.sessionMemoryDir
	}
}
function getMemoryTitle(text: string, kind: string): string {
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean)
		?.replace(/^[#>*\-\d.\s]+/, "")
		?.replace(/[`*_~]+/g, "")
		.trim()
	const firstSentence = firstLine?.split(/[.!?](?:\s|$)/)[0]?.trim()
	const stem = slugifyMemoryName(
		firstSentence || firstLine || kind || "memory_entry",
	)
	const words = stem.split("_").filter(Boolean).slice(0, 8)
	return words.join("_") || `${slugifyMemoryName(kind || "memory")}_entry`
}
async function getUniqueMemoryStem(
	dir: string,
	preferredStem: string,
): Promise<string> {
	const baseStem = preferredStem || "memory_entry"
	let candidate = baseStem
	let index = 2
	while (await exists(path.join(dir, `${candidate}.md`))) {
		candidate = `${baseStem}_${index}`
		index += 1
	}
	return candidate
}

async function collectMarkdownFiles(
	dir: string,
	baseDir: string = dir,
): Promise<string[]> {
	if (!(await exists(dir))) return []
	const entries = await readdir(dir, { withFileTypes: true })
	const files: string[] = []
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await collectMarkdownFiles(fullPath, baseDir)))
			continue
		}
		if (entry.isFile() && entry.name.endsWith(".md"))
			files.push(path.relative(baseDir, fullPath))
	}
	return files.sort()
}
async function getRecentFiles(
	dir: string,
	limit: number,
): Promise<Array<{ file: string; mtimeMs: number }>> {
	if (!(await exists(dir))) return []
	const results: Array<{ file: string; mtimeMs: number }> = []
	const entries = await readdir(dir, { withFileTypes: true })
	for (const entry of entries) {
		if (entry.name === ".git") continue
		const fullPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			results.push(...(await getRecentFiles(fullPath, limit)))
			continue
		}
		if (!entry.isFile()) continue
		const info = await stat(fullPath)
		results.push({ file: fullPath, mtimeMs: info.mtimeMs })
	}
	return results.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}
function getDefaultFiles(
	cwd: string,
	agentId: string,
	paths: MemoryPaths,
): Record<string, string> {
	const projectSlug = getProjectSlug(cwd)
	const now = new Date().toISOString()
	return {
		[path.join(paths.workTree, "README.md")]:
			`# Pietta Memory\n\nThis git-backed worktree stores durable memory for agent \`${agentId}\`.\n`,
		[path.join(paths.profileDir, "preferences.md")]:
			`# Preferences\n\nStable project and agent preferences.\n`,
		[path.join(paths.profileDir, "environment.md")]:
			`# Environment\n\nEnvironment constraints.\n`,
		[path.join(paths.profileDir, "habits.md")]:
			`# Habits\n\nRepeated workflow habits.\n`,
		[paths.projectSummaryFile]: `# ${projectSlug} Summary\n\n- Initialized: ${now}\n- Agent: ${agentId}\n`,
		[paths.projectDecisionsFile]: `# Decisions\n\n`,
		[paths.timelineFile]: "",
		[paths.scratchpadFile]: `# Scratchpad\n\n`,
		[paths.latestSummaryFile]: `# Latest Summary\n\nNo generated summary yet.\n`,
		[paths.candidatesFile]: "",
		[path.join(paths.projectRulesDir, "README.md")]: "# Project Rules\n\n",
		[path.join(paths.agentRulesDir, "README.md")]: "# Agent Rules\n\n",
		[path.join(paths.generatedRulesDir, "README.md")]: "# Generated Rules\n\n",
	}
}
async function ensureAgentLayout(
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

	for (const dir of [
		basePaths.profileDir,
		basePaths.projectDir,
		basePaths.projectFactsDir,
		basePaths.sessionsDir,
		basePaths.sessionMemoryDir,
		basePaths.summariesDir,
		basePaths.inboxDir,
		basePaths.rulesDir,
		basePaths.projectRulesDir,
		basePaths.agentRulesDir,
		basePaths.generatedRulesDir,
		basePaths.agentNotesDir,
	]) {
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
async function ensureWorktreeLayout(
	cwd: string,
	agentId: string,
	paths: MemoryPaths,
): Promise<void> {
	if (!(await hasGitWorkTreeFile(paths.workTree))) {
		throw new Error(`Refusing to populate non-git worktree: ${paths.workTree}`)
	}
	for (const dir of [
		paths.profileDir,
		paths.projectDir,
		paths.projectFactsDir,
		paths.sessionsDir,
		paths.sessionMemoryDir,
		paths.summariesDir,
		paths.inboxDir,
		paths.rulesDir,
		paths.projectRulesDir,
		paths.agentRulesDir,
		paths.generatedRulesDir,
		paths.agentNotesDir,
	]) {
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

async function resolveMutationPaths(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
): Promise<{ paths: MemoryPaths; worktreeKey: string; source: string }> {
	const sessionId = ctx.sessionManager.getSessionId().trim()
	const sessionFile = ctx.sessionManager.getSessionFile()
	const source = sessionFile || sessionId || "ephemeral"
	const worktreeKey = getSessionWorktreeKey(ctx)
	const { paths } = await ensureAgentLayout(pi, ctx.cwd, agentId, worktreeKey)
	await syncWorktreeWithCanonical(pi, paths, worktreeKey)
	await ensureWorktreeLayout(ctx.cwd, agentId, paths)
	return { paths, worktreeKey, source }
}
async function resolveReadPaths(
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

async function collectMemoryItemsFromPaths(
	paths: MemoryPaths,
): Promise<MemoryItem[]> {
	const files = (
		await Promise.all(
			getMemoryRoots(paths).map(async ({ scope, dir }) => {
				const recentFiles = await getRecentFiles(dir, 500)
				return recentFiles.map((file) => ({ ...file, scope }))
			}),
		)
	).flat()
	const items: MemoryItem[] = []
	for (const file of files) {
		if (!file.file.endsWith(".md")) continue
		const parsed = parseFrontmatterBlock(await readFile(file.file, "utf8"))
		items.push({
			id:
				typeof parsed.data.id === "string"
					? parsed.data.id
					: getMemoryItemId(file.scope, file.file),
			filePath: file.file,
			scope: file.scope,
			kind: typeof parsed.data.kind === "string" ? parsed.data.kind : "fact",
			createdAt:
				typeof parsed.data.created_at === "string"
					? parsed.data.created_at
					: undefined,
			updatedAt:
				typeof parsed.data.updated_at === "string"
					? parsed.data.updated_at
					: undefined,
			sources: Array.isArray(parsed.data.sources) ? parsed.data.sources : [],
			body: parsed.body,
		})
	}
	return items.sort((a, b) =>
		(b.updatedAt ?? b.createdAt ?? "").localeCompare(
			a.updatedAt ?? a.createdAt ?? "",
		),
	)
}
async function findMemoryItemInPaths(
	paths: MemoryPaths,
	selector: string,
): Promise<MemoryItem | null> {
	const normalized = selector.trim()
	if (!normalized) return null
	const items = await collectMemoryItemsFromPaths(paths)
	return (
		items.find(
			(item) =>
				item.id === normalized ||
				item.filePath === normalized ||
				path.basename(item.filePath) === normalized,
		) ??
		items.find(
			(item) =>
				item.id.includes(normalized) || item.filePath.includes(normalized),
		) ??
		null
	)
}

async function appendTimeline(
	paths: MemoryPaths,
	entry: Record<string, unknown>,
): Promise<void> {
	await appendFile(paths.timelineFile, `${JSON.stringify(entry)}\n`, "utf8")
}

async function appendCandidates(
	paths: MemoryPaths,
	entry: Record<string, unknown>,
): Promise<void> {
	await appendFile(paths.candidatesFile, `${JSON.stringify(entry)}\n`, "utf8")
}
async function remember(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
	input: RememberInput,
): Promise<string> {
	const { paths, worktreeKey, source } = await resolveMutationPaths(
		pi,
		ctx,
		agentId,
	)
	const now = new Date().toISOString()
	const provenanceSource = input.source?.trim() || source
	const dir = getRememberDir(paths, input.scope)
	const stem = await getUniqueMemoryStem(
		dir,
		getMemoryTitle(input.text, input.kind),
	)
	const id = `${input.scope}/${stem}`
	const filePath = path.join(dir, `${stem}.md`)
	const content = `${frontmatter({
		id,
		scope: input.scope,
		project: getProjectSlug(ctx.cwd),
		agent: agentId,
		kind: input.kind,
		confidence: input.confidence.toFixed(2),
		sources: [provenanceSource],
		created_at: now,
		updated_at: now,
	})}\n\n${input.text.trim()}\n`
	await writeFile(filePath, content, "utf8")
	await appendTimeline(paths, {
		id,
		timestamp: now,
		action: "remember",
		agent: agentId,
		scope: input.scope,
		kind: input.kind,
		file: filePath,
		source: provenanceSource,
	})
	await appendCandidates(paths, {
		id,
		timestamp: now,
		action: "remember",
		agent: agentId,
		scope: input.scope,
		kind: input.kind,
		confidence: input.confidence,
		text: input.text.trim(),
		file: filePath,
		source: provenanceSource,
	})
	await commitWorktreeChanges(
		pi,
		paths.workTree,
		`feat(memory): remember ${id}`,
		toWorktreeRelativePaths(paths, [
			filePath,
			paths.timelineFile,
			paths.candidatesFile,
		]),
	)
	await fastForwardCanonicalBranch(pi, paths, worktreeKey)
	await pushCanonicalBranchToBare(pi, paths)

	return filePath
}

async function updateMemoryItem(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
	selector: string,
	text: string,
	options?: { mode?: "replace" | "append"; source?: string },
): Promise<MemoryItem> {
	const { paths, worktreeKey, source } = await resolveMutationPaths(
		pi,
		ctx,
		agentId,
	)
	const item = await findMemoryItemInPaths(paths, selector)
	if (!item) throw new Error(`Could not find memory item: ${selector}`)
	const now = new Date().toISOString()
	const provenanceSource = options?.source?.trim() || source
	const parsed = parseFrontmatterBlock(await readFile(item.filePath, "utf8"))
	const sources = new Set(
		Array.isArray(parsed.data.sources) ? parsed.data.sources : [],
	)
	sources.add(provenanceSource)
	const nextBody =
		options?.mode === "append"
			? `${parsed.body.trim()}\n\n${text.trim()}`.trim()
			: text.trim()

	await writeFile(
		item.filePath,
		`${frontmatter({
			id: typeof parsed.data.id === "string" ? parsed.data.id : item.id,
			scope:
				typeof parsed.data.scope === "string" ? parsed.data.scope : item.scope,
			project:
				typeof parsed.data.project === "string"
					? parsed.data.project
					: getProjectSlug(ctx.cwd),
			agent:
				typeof parsed.data.agent === "string" ? parsed.data.agent : agentId,
			kind: typeof parsed.data.kind === "string" ? parsed.data.kind : item.kind,
			confidence:
				typeof parsed.data.confidence === "string"
					? parsed.data.confidence
					: "0.90",
			sources: [...sources],
			created_at:
				typeof parsed.data.created_at === "string"
					? parsed.data.created_at
					: now,
			updated_at: now,
		})}\n\n${nextBody}\n`,
		"utf8",
	)
	await appendTimeline(paths, {
		id: item.id,
		timestamp: now,
		action: "update",
		agent: agentId,
		file: item.filePath,
		mode: options?.mode ?? "replace",
		source: provenanceSource,
	})
	await commitWorktreeChanges(
		pi,
		paths.workTree,
		`docs(memory): update ${item.id}`,
		toWorktreeRelativePaths(paths, [item.filePath, paths.timelineFile]),
	)
	await fastForwardCanonicalBranch(pi, paths, worktreeKey)
	await pushCanonicalBranchToBare(pi, paths)

	return {
		...item,
		body: nextBody,
		updatedAt: now,
		sources: [...sources],
	}
}

async function getMemoryHistoryFromPaths(
	pi: ExtensionAPI,
	paths: MemoryPaths,
	selector: string,
	limit: number = 20,
): Promise<string> {
	const item = await findMemoryItemInPaths(paths, selector)
	if (!item) throw new Error(`Could not find memory item: ${selector}`)
	const relativePath = path.relative(paths.workTree, item.filePath)
	const result = await gitOrThrow(
		pi,
		[
			"log",
			"--follow",
			`--max-count=${limit}`,
			"--date=iso-strict",
			"--format=%H%x09%ad%x09%s",
			"--",
			relativePath,
		],
		`Failed to read git history for ${item.id}`,
		{ cwd: paths.workTree },
	)
	const entries = result.stdout.trim().split(/\r?\n/).filter(Boolean)
	if (entries.length === 0) return `No git history found for ${item.id}`
	return [
		`History for ${item.id}`,
		`Path: ${item.filePath}`,
		"",
		...entries.map((line) => {
			const [commit, date, subject] = line.split("\t")
			return `- ${date} ${commit.slice(0, 12)} ${subject}`
		}),
	].join("\n")
}
async function deleteMemoryItem(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
	selector: string,
): Promise<MemoryItem> {
	const { paths, worktreeKey, source } = await resolveMutationPaths(
		pi,
		ctx,
		agentId,
	)
	const item = await findMemoryItemInPaths(paths, selector)
	if (!item) throw new Error(`Could not find memory item: ${selector}`)
	await unlink(item.filePath)
	const now = new Date().toISOString()
	const provenanceSource = source
	await appendTimeline(paths, {
		id: item.id,
		timestamp: now,
		action: "delete",
		agent: agentId,
		file: item.filePath,
		source: provenanceSource,
	})
	await appendCandidates(paths, {
		id: item.id,
		timestamp: now,
		action: "delete",
		agent: agentId,
		file: item.filePath,
		source: provenanceSource,
	})
	await commitWorktreeChanges(
		pi,
		paths.workTree,
		`chore(memory): delete ${item.id}`,
		toWorktreeRelativePaths(paths, [
			item.filePath,
			paths.timelineFile,
			paths.candidatesFile,
		]),
	)
	await fastForwardCanonicalBranch(pi, paths, worktreeKey)
	await pushCanonicalBranchToBare(pi, paths)

	return item
}
function renderMemoryItem(item: MemoryItem): string {
	return [
		`ID: ${item.id}`,
		`Scope: ${item.scope}`,
		`Kind: ${item.kind}`,
		`Path: ${item.filePath}`,
		`Created: ${item.createdAt ?? "unknown"}`,
		`Updated: ${item.updatedAt ?? "unknown"}`,
		`Sources: ${item.sources.length > 0 ? item.sources.join(", ") : "none"}`,
		"",
		item.body || "(empty)",
	].join("\n")
}
function renderMemoryList(items: MemoryItem[], limit: number = 20): string {
	if (items.length === 0) return "No memory items found"
	return items
		.slice(0, limit)
		.map(
			(item) =>
				`- ${item.id} [${item.scope}/${item.kind}] ${item.updatedAt ?? item.createdAt ?? "unknown"}\n  ${item.filePath}`,
		)
		.join("\n")
}
async function renderMemoryOverview(
	pi: ExtensionAPI,
	cwd: string,
	agentId: string,
): Promise<string> {
	const { paths } = await ensureAgentLayout(pi, cwd, agentId)
	const recentFiles = await getRecentFiles(paths.workTree, 8)
	const rules = await collectMarkdownFiles(paths.rulesDir)
	const worktrees = await listMemoryWorktrees(pi, paths)
	const syncStatus = await renderSyncStatus(pi, paths)
	return [
		`Agent: ${agentId}`,
		`Memory root: ${paths.workTree}`,
		`Canonical worktree: ${getCanonicalWorkTree(paths)}`,
		`Canonical repo: ${paths.bareRepo}`,
		`Project summary: ${paths.projectSummaryFile}`,
		`Latest summary: ${paths.latestSummaryFile}`,
		`Rules: ${rules.length}`,
		`Worktrees: ${worktrees.length}`,
		...syncStatus,
		"",
		"Attached worktrees:",
		...(worktrees.length > 0
			? worktrees.map(
					(worktree) =>
						`- ${worktree.path}${worktree.branch ? ` [${worktree.branch}]` : " [detached]"}`,
				)
			: ["- No worktrees found"]),
		"",
		"Recent files:",
		...(recentFiles.length > 0
			? recentFiles.map((item) => `- ${item.file}`)
			: ["- No memory files yet"]),
	].join("\n")
}
async function readFileIfPresent(filePath: string): Promise<string | null> {
	if (!(await exists(filePath))) return null
	return readFile(filePath, "utf8")
}
async function grepMemoryInPaths(
	pi: ExtensionAPI,
	paths: MemoryPaths,
	query: string,
	limit: number = 30,
): Promise<string> {
	const grepRoots = [
		paths.projectDir,
		paths.profileDir,
		paths.agentNotesDir,
		paths.sessionMemoryDir,
		paths.rulesDir,
		paths.summariesDir,
		paths.inboxDir,
	]
	try {
		const result = await pi.exec("rg", [
			"--hidden",
			"--line-number",
			"--smart-case",
			"--glob",
			"!.git",
			"--glob",
			"!node_modules",
			"--max-count",
			String(limit),
			query,
			...grepRoots,
		])
		const combined =
			[result.stdout, result.stderr].filter(Boolean).join("\n").trim() ||
			"No matches found"
		const truncation = truncateHead(combined, {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		})
		if (!truncation.truncated) return truncation.content
		return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (
			/\b(exit code|code)\s*1\b/i.test(message) ||
			/no matches?/i.test(message)
		)
			return "No matches found"
		throw error
	}
}
async function buildInjectedContext(
	pi: ExtensionAPI,
	cwd: string,
	agentId: string,
): Promise<string | null> {
	const { paths } = await ensureAgentLayout(pi, cwd, agentId)
	const projectSummary = (
		await readFileIfPresent(paths.projectSummaryFile)
	)?.trim()
	const latestSummary = (
		await readFileIfPresent(paths.latestSummaryFile)
	)?.trim()
	const ruleFiles = await collectMarkdownFiles(paths.rulesDir)
	const blocks = [
		"# Pietta Context",
		`- agent: ${agentId}`,
		`- memory_root: ${paths.workTree}`,
		"",
		"## Memory Discipline",
		"- Treat explicit user preferences as durable memory.",
		"- If the user says something is their preference, default, usual workflow, or recurring constraint, store it in Pietta memory.",
		"- Do this proactively without asking for confirmation unless the user says not to remember it.",
		"- Never store secrets, credentials, or clearly temporary details.",
	]
	if (projectSummary) blocks.push(`## Project Summary\n${projectSummary}`)
	if (
		latestSummary &&
		latestSummary !== "# Latest Summary\n\nNo generated summary yet."
	)
		blocks.push(`## Latest Summary\n${latestSummary}`)
	if (ruleFiles.length > 0)
		blocks.push(
			`## Available Rules\n${ruleFiles.map((file) => `- ${path.join(paths.rulesDir, file)}`).join("\n")}`,
		)
	return (
		truncateHead(blocks.join("\n\n"), {
			maxBytes: 12_000,
			maxLines: 300,
		}).content.trim() || null
	)
}
function parseAgentsArgs(args: string): { command: string; value?: string } {
	const [command = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean)
	return { command, value: rest.join(" ") || undefined }
}
function parseRememberArgs(args: string): { scope: Scope; text: string } {
	const trimmed = args.trim()
	if (!trimmed) return { scope: "project", text: "" }
	const [first, ...rest] = trimmed.split(/\s+/)
	if ((SCOPE_VALUES as readonly string[]).includes(first))
		return { scope: first as Scope, text: rest.join(" ") }
	return { scope: "project", text: trimmed }
}

function parseMemoryArgs(args: string): {
	command: string
	selector?: string
	text?: string
} {
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
export default function piettaExtension(pi: ExtensionAPI) {
	let currentAgentId = DEFAULT_AGENT_ID
	async function syncState(): Promise<void> {
		const state = await loadState()
		currentAgentId = sanitizeAgentId(state.currentAgentId)
	}

	async function setCurrentAgent(agentId: string): Promise<void> {
		currentAgentId = sanitizeAgentId(agentId)
		await saveState({ currentAgentId })
	}
	pi.on("session_start", async (_event, ctx) => {
		await syncState()
		await ensureAgentLayout(pi, ctx.cwd, currentAgentId)
		ctx.ui.setStatus(
			EXTENSION_NAME,
			ctx.ui.theme.fg("accent", `pietta:${currentAgentId}`),
		)
	})
	pi.on("session_shutdown", async (_event, ctx) => {
		await syncState()
		const agentIds = new Set([...getAgentIds(), currentAgentId])
		for (const agentId of agentIds) {
			try {
				await deleteSessionWorktreeForAgent(pi, ctx, agentId)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				ctx.ui.notify(
					`Failed to clean up Pietta session worktree for ${agentId}: ${message}`,
					"warning",
				)
			}
		}
	})
	pi.on("before_agent_start", async (_event, ctx) => {
		await syncState()
		const context = await buildInjectedContext(pi, ctx.cwd, currentAgentId)
		if (!context) return
		return {
			message: {
				customType: "pietta-context",
				content: `${context}\n\nUse read or Pietta tools for more detail.`,
				display: false,
			},
		}
	})
	pi.registerCommand("pietta-init", {
		description: "Initialize Pietta memory for the current or selected agent",
		getArgumentCompletions: (prefix) =>
			toAutocompleteItems(getAgentIds(), prefix),
		handler: async (args, ctx) => {
			await syncState()
			const agentId = sanitizeAgentId(args || currentAgentId)
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
			const agentId = sanitizeAgentId(args || currentAgentId)
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
			const filePath = await remember(pi, ctx, currentAgentId, {
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
					? `Current agent: ${currentAgentId}\n\nAgents:\n${entries.map((entry) => `${entry === currentAgentId ? "*" : "-"} ${entry}`).join("\n")}`
					: `Current agent: ${currentAgentId}\n\nNo other agents yet`,
				"info",
			)
		},
	})

	pi.registerTool({
		name: "pietta_grep_memory",
		label: "Pietta Grep Memory",
		description:
			"Search Pietta memory files for the current agent exactly like ripgrep, including regex patterns",
		promptSnippet:
			"Use pietta_grep_memory like ripgrep: pass plain text or regex directly to search durable notes, preferences, rules, and prior decisions",
		promptGuidelines: [
			"Use this tool exactly like ripgrep: pass the search pattern directly as the query.",
			"The query can be plain text or a regular expression, just like rg.",
			"Always use this tool instead of guessing when the user asks what you remember, asks about prior preferences, or asks you to recall earlier durable context.",
			"Use this tool before guessing about prior project preferences, rules, or decisions.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"ripgrep-style search pattern for Pietta memory, including plain text or regex",
			}),
			agentId: Type.Optional(
				Type.String({ description: "Optional agent ID override" }),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum matches to return",
					minimum: 1,
					maximum: 200,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await syncState()
			const agentId = sanitizeAgentId(params.agentId || currentAgentId)
			const paths = await resolveReadPaths(pi, ctx, agentId)
			return {
				content: [
					{
						type: "text",
						text: await grepMemoryInPaths(
							pi,
							paths,
							params.query,
							params.limit ?? 30,
						),
					},
				],
				details: { agentId, query: params.query, workTree: paths.workTree },
			}
		},
	})

	pi.registerTool({
		name: "pietta_write_memory",
		label: "Pietta Write Memory",
		description:
			"Write durable memory entries into the Pietta agent memory repo",
		promptSnippet:
			"Store durable memory aggressively, especially explicit user preferences and recurring constraints",
		promptGuidelines: [
			"Always write durable memory when the user explicitly states a preference, default, recurring workflow, or standing constraint.",
			"Do not wait for the user to ask to remember it if the preference is stated clearly.",
			"Use this only for durable facts, preferences, rules, decisions, and environment constraints.",
			"Do not store speculative assumptions, temporary plans, secrets, or credentials.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "The durable memory text to store" }),
			scope: Type.Optional(
				StringEnum(SCOPE_VALUES, { description: "Memory scope" }),
			),
			kind: Type.Optional(Type.String({ description: "Memory kind" })),
			confidence: Type.Optional(
				Type.Number({
					description: "Confidence from 0 to 1",
					minimum: 0,
					maximum: 1,
				}),
			),
			source: Type.Optional(
				Type.String({ description: "Optional provenance source" }),
			),
			agentId: Type.Optional(
				Type.String({ description: "Optional agent ID override" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await syncState()
			const agentId = sanitizeAgentId(params.agentId || currentAgentId)
			const filePath = await remember(pi, ctx, agentId, {
				text: params.text,
				scope: params.scope ?? "project",
				kind: params.kind?.trim() || "fact",
				confidence: params.confidence ?? 0.9,
				source: params.source,
			})
			return {
				content: [{ type: "text", text: `Stored memory in ${filePath}` }],
				details: { agentId, filePath },
			}
		},
	})

	pi.registerTool({
		name: "pietta_update_memory",
		label: "Pietta Update Memory",
		description:
			"Update an existing Pietta memory item and refresh its updated_at field",
		promptSnippet: "Update an existing Pietta memory entry by id or path",
		promptGuidelines: [
			"Use this when the user wants to revise or correct an existing durable memory item.",
		],
		parameters: Type.Object({
			selector: Type.String({
				description: "Memory id, filename, or full path",
			}),
			text: Type.String({ description: "New body text for the memory item" }),
			mode: Type.Optional(
				StringEnum(["replace", "append"] as const, {
					description: "Replace or append to the current body",
				}),
			),
			source: Type.Optional(
				Type.String({ description: "Optional provenance source" }),
			),
			agentId: Type.Optional(
				Type.String({ description: "Optional agent ID override" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await syncState()
			const agentId = sanitizeAgentId(params.agentId || currentAgentId)
			const updated = await updateMemoryItem(
				pi,
				ctx,
				agentId,
				params.selector,
				params.text,
				{
					mode: params.mode ?? "replace",
					source: params.source,
				},
			)
			return {
				content: [
					{
						type: "text",
						text: `Updated ${updated.id} in ${updated.filePath}`,
					},
				],
				details: {
					agentId,
					id: updated.id,
					filePath: updated.filePath,
					updatedAt: updated.updatedAt,
				},
			}
		},
	})

	pi.registerTool({
		name: "pietta_delete_memory",
		label: "Pietta Delete Memory",
		description:
			"Delete an existing Pietta memory item and log the deletion in jsonl timelines",
		promptSnippet: "Delete an existing Pietta memory entry by id or path",
		promptGuidelines: [
			"Use this when the user explicitly wants a memory item forgotten or removed.",
		],
		parameters: Type.Object({
			selector: Type.String({
				description: "Memory id, filename, or full path",
			}),
			agentId: Type.Optional(
				Type.String({ description: "Optional agent ID override" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await syncState()
			const agentId = sanitizeAgentId(params.agentId || currentAgentId)
			const deleted = await deleteMemoryItem(pi, ctx, agentId, params.selector)
			return {
				content: [
					{
						type: "text",
						text: `Deleted ${deleted.id} from ${deleted.filePath}`,
					},
				],
				details: { agentId, id: deleted.id, filePath: deleted.filePath },
			}
		},
	})
}
