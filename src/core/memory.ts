import {
	appendFile,
	readdir,
	readFile,
	stat,
	unlink,
	mkdir,
	writeFile,
} from "node:fs/promises"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
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
import {
	commitWorktreeChanges,
	fastForwardCanonicalBranch,
	gitOrThrow,
	listMemoryWorktrees,
	pushCanonicalBranchToBare,
	renderSyncStatus,
	toWorktreeRelativePaths,
} from "./git.js"
import { ensureAgentLayout, resolveMutationPaths } from "./layout.js"
import {
	exists,
	getCanonicalWorkTree,
	getPaths,
	getProjectSlug,
	slugifyMemoryName,
} from "./paths.js"
import type { MemoryItem, MemoryPaths, RememberInput, Scope } from "./types.js"

export const EMPTY_LATEST_SUMMARY =
	"# Latest Summary\n\nNo generated summary yet."

function uniquePaths(pathsList: string[]): string[] {
	return [...new Set(pathsList)]
}

const mutationQueues = new Map<string, Promise<void>>()

async function withAgentMutationLock<T>(
	agentId: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = mutationQueues.get(agentId) ?? Promise.resolve()
	let release!: () => void
	const current = new Promise<void>((resolve) => {
		release = resolve
	})
	const queued = previous.catch(() => undefined).then(() => current)
	mutationQueues.set(agentId, queued)
	await previous.catch(() => undefined)
	try {
		return await operation()
	} finally {
		release()
		if (mutationQueues.get(agentId) === queued) mutationQueues.delete(agentId)
	}
}

export function getRuleRoots(paths: MemoryPaths): string[] {
	return uniquePaths([paths.projectRulesDir, paths.rulesDir])
}

export function getPinnedSystemRoots(paths: MemoryPaths): string[] {
	return uniquePaths([paths.systemDir, paths.projectSystemDir])
}
export function getMemoryRoots(
	paths: MemoryPaths,
): Array<{ scope: Scope; dir: string }> {
	const roots: Array<{ scope: Scope; dir: string }> = [
		{ scope: "project", dir: paths.projectDir },
		{ scope: "agent", dir: paths.systemDir },
		{ scope: "session", dir: paths.sessionMemoryDir },
	]
	return roots
}
function isUnderDir(filePath: string, dir: string): boolean {
	const relativePath = path.relative(dir, filePath)
	return (
		relativePath !== "" &&
		!relativePath.startsWith("..") &&
		!path.isAbsolute(relativePath)
	)
}

function isScaffoldMemoryFile(paths: MemoryPaths, filePath: string): boolean {
	return (
		filePath === path.join(paths.systemDir, "README.md") ||
		filePath === path.join(paths.projectSystemDir, "README.md") ||
		filePath === paths.projectSummaryFile ||
		filePath === path.join(paths.projectRulesDir, "README.md") ||
		filePath === path.join(paths.agentRulesDir, "README.md") ||
		filePath === path.join(paths.generatedRulesDir, "README.md")
	)
}
export function isListedMemoryFile(
	paths: MemoryPaths,
	filePath: string,
): boolean {
	if (filePath === paths.projectSummaryFile) return false
	if (!filePath.endsWith(".md")) return false
	if (isScaffoldMemoryFile(paths, filePath)) return false
	if (isUnderDir(filePath, paths.projectSystemDir)) return false
	if (isUnderDir(filePath, paths.projectRulesDir)) return false
	if (isUnderDir(filePath, paths.agentRulesDir)) return false
	if (isUnderDir(filePath, paths.generatedRulesDir)) return false
	return true
}

export function getMemoryItemId(
	scope: Scope,
	filePath: string,
	rootDir?: string,
): string {
	const relativePath = rootDir
		? path.relative(rootDir, filePath).replace(/\\/g, "/")
		: path.basename(filePath)
	return `${scope}/${relativePath.replace(/\.md$/i, "")}`
}

export function frontmatter(
	fields: Record<string, string | number | string[]>,
): string {
	const lines = Object.entries(fields).flatMap(([key, value]) => {
		if (Array.isArray(value))
			return [`${key}:`, ...value.map((item) => `  - ${item}`)]
		return [`${key}: ${value}`]
	})
	return `---\n${lines.join("\n")}\n---`
}

export function parseFrontmatterBlock(content: string): {
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

export function getRememberDir(
	paths: MemoryPaths,
	scope: Scope,
	kind: string,
	text: string,
): string {
	if (scope === "session") return paths.sessionMemoryDir
	if (scope === "agent") return paths.systemDir
	if (scope !== "project") return paths.projectDir

	const signal = `${kind} ${text}`.toLowerCase()
	if (
		/(rule|policy|constraint|preference|workflow|convention|guideline|standard|always|never|should|must)/.test(
			signal,
		)
	)
		return paths.projectSystemDir
	return paths.projectDir
}

export function sanitizeMemoryPathSegment(value: string): string {
	return slugifyMemoryName(value.replace(/\.md$/i, "")).replace(/^_+|_+$/g, "")
}

export function sanitizeRelativeMemoryPath(value: string): string | null {
	const parts = value
		.split(/[\\/]+/)
		.map((part) => sanitizeMemoryPathSegment(part.trim()))
		.filter(Boolean)
	if (parts.length === 0) return null
	return parts.join("/")
}

export async function resolveRememberTarget(
	baseDir: string,
	preferredStem: string,
	explicitPath?: string,
): Promise<{ relativePath: string; filePath: string }> {
	const sanitizedPath = explicitPath
		? sanitizeRelativeMemoryPath(explicitPath)
		: null
	if (!sanitizedPath) {
		const stem = await getUniqueMemoryStem(baseDir, preferredStem)
		return {
			relativePath: stem,
			filePath: path.join(baseDir, `${stem}.md`),
		}
	}

	const parts = sanitizedPath.split("/")
	const leaf = parts.pop() || preferredStem
	const nestedDir = path.join(baseDir, ...parts)
	const stem = await getUniqueMemoryStem(nestedDir, leaf || preferredStem)
	const relativePath = [...parts, stem].filter(Boolean).join("/")
	return {
		relativePath,
		filePath: path.join(baseDir, `${relativePath}.md`),
	}
}
export function getMemoryTitle(text: string, kind: string): string {
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
export async function getUniqueMemoryStem(
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

export async function collectMarkdownFiles(
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

export async function getRecentFiles(
	dir: string,
	limit: number,
	includeFile?: (filePath: string) => boolean,
): Promise<Array<{ file: string; mtimeMs: number }>> {
	if (!(await exists(dir))) return []
	const results: Array<{ file: string; mtimeMs: number }> = []
	const entries = await readdir(dir, { withFileTypes: true })
	for (const entry of entries) {
		if (entry.name === ".git") continue
		const fullPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			results.push(...(await getRecentFiles(fullPath, limit, includeFile)))
			continue
		}
		if (!entry.isFile()) continue
		if (includeFile && !includeFile(fullPath)) continue
		const info = await stat(fullPath)
		results.push({ file: fullPath, mtimeMs: info.mtimeMs })
	}
	return results.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}

export function getMemoryItemIdsSync(cwd: string, agentId: string): string[] {
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
				if (!entry.isFile() || !isListedMemoryFile(paths, fullPath)) continue
				const parsed = parseFrontmatterBlock(readFileSync(fullPath, "utf8"))
				ids.add(
					typeof parsed.data.id === "string"
						? parsed.data.id
						: getMemoryItemId(scope, fullPath, dir),
				)
			}
		}
	}
	return [...ids].sort()
}

export function getMemoryWorktreeKeysSync(
	cwd: string,
	agentId: string,
): string[] {
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

export async function collectMemoryItemsFromPaths(
	paths: MemoryPaths,
): Promise<MemoryItem[]> {
	const files = (
		await Promise.all(
			getMemoryRoots(paths).map(async ({ scope, dir }) => {
				const recentFiles = await getRecentFiles(dir, 500, (filePath) =>
					isListedMemoryFile(paths, filePath),
				)
				return recentFiles.map((file) => ({ ...file, scope, rootDir: dir }))
			}),
		)
	).flat()
	const items: MemoryItem[] = []
	for (const file of files) {
		if (!isListedMemoryFile(paths, file.file)) continue
		const parsed = parseFrontmatterBlock(await readFile(file.file, "utf8"))
		items.push({
			id:
				typeof parsed.data.id === "string"
					? parsed.data.id
					: getMemoryItemId(file.scope, file.file, file.rootDir),
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

export async function findMemoryItemInPaths(
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

export async function appendTimeline(
	paths: MemoryPaths,
	entry: Record<string, unknown>,
): Promise<void> {
	await appendFile(paths.timelineFile, `${JSON.stringify(entry)}\n`, "utf8")
}

export async function remember(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
	input: RememberInput,
): Promise<string> {
	return withAgentMutationLock(agentId, async () => {
		const { paths, worktreeKey, source } = await resolveMutationPaths(
			pi,
			ctx,
			agentId,
		)
		const now = new Date().toISOString()
		const provenanceSource = input.source?.trim() || source
		const dir = getRememberDir(paths, input.scope, input.kind, input.text)
		const preferredStem = getMemoryTitle(input.text, input.kind)
		const target = await resolveRememberTarget(dir, preferredStem, input.path)
		const id = `${input.scope}/${target.relativePath}`
		const filePath = target.filePath
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
		})}
${input.text.trim()}
`
		await mkdir(path.dirname(filePath), { recursive: true })
		await writeFile(filePath, content, "utf8")
		await appendTimeline(paths, {
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
			toWorktreeRelativePaths(paths, [filePath, paths.timelineFile]),
		)
		await fastForwardCanonicalBranch(pi, paths, worktreeKey)
		await pushCanonicalBranchToBare(pi, paths)
		return filePath
	})
}

export async function updateMemoryItem(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
	selector: string,
	text: string,
	options?: { mode?: "replace" | "append"; source?: string },
): Promise<MemoryItem> {
	return withAgentMutationLock(agentId, async () => {
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
					typeof parsed.data.scope === "string"
						? parsed.data.scope
						: item.scope,
				project:
					typeof parsed.data.project === "string"
						? parsed.data.project
						: getProjectSlug(ctx.cwd),
				agent:
					typeof parsed.data.agent === "string" ? parsed.data.agent : agentId,
				kind:
					typeof parsed.data.kind === "string" ? parsed.data.kind : item.kind,
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
			})}
${nextBody}
`,
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
	})
}

export async function getMemoryHistoryFromPaths(
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

export async function deleteMemoryItem(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
	selector: string,
): Promise<MemoryItem> {
	return withAgentMutationLock(agentId, async () => {
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
		await commitWorktreeChanges(
			pi,
			paths.workTree,
			`chore(memory): delete ${item.id}`,
			toWorktreeRelativePaths(paths, [item.filePath, paths.timelineFile]),
		)
		await fastForwardCanonicalBranch(pi, paths, worktreeKey)
		await pushCanonicalBranchToBare(pi, paths)
		return item
	})
}

export function renderMemoryItem(item: MemoryItem): string {
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

export function renderMemoryList(
	items: MemoryItem[],
	limit: number = 20,
): string {
	if (items.length === 0) return "No memory items found"
	return items
		.slice(0, limit)
		.map(
			(item) =>
				`- ${item.id} [${item.scope}/${item.kind}] ${item.updatedAt ?? item.createdAt ?? "unknown"}\n  ${item.filePath}`,
		)
		.join("\n")
}

export async function renderMemoryOverview(
	pi: ExtensionAPI,
	cwd: string,
	agentId: string,
): Promise<string> {
	const { paths } = await ensureAgentLayout(pi, cwd, agentId)
	const recentFiles = await getRecentFiles(paths.workTree, 8)
	const rules = (
		await Promise.all(
			getRuleRoots(paths).map((dir) => collectMarkdownFiles(dir)),
		)
	).flat()
	const worktrees = await listMemoryWorktrees(pi, paths)
	const syncStatus = await renderSyncStatus(pi, paths)
	return [
		`Agent: ${agentId}`,
		`Memory root: ${paths.workTree}`,
		`Canonical worktree: ${getCanonicalWorkTree(paths)}`,
		`Canonical repo: ${paths.bareRepo}`,
		"",
		"Hierarchy:",
		`- system/ (pinned): ${paths.systemDir}`,
		`- projects/<slug>/: ${paths.projectDir}`,
		`- sessions/: ${paths.sessionsDir}`,
		`- archive/: ${paths.archiveDir}`,
		"",
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
export async function readFileIfPresent(
	filePath: string,
): Promise<string | null> {
	if (!(await exists(filePath))) return null
	return readFile(filePath, "utf8")
}

export async function readFirstPresentFile(
	filePaths: string[],
): Promise<string | null> {
	for (const filePath of uniquePaths(filePaths)) {
		const content = await readFileIfPresent(filePath)
		if (content !== null) return content
	}
	return null
}

export async function collectMarkdownFilesFromRoots(
	roots: string[],
): Promise<string[]> {
	const files = (
		await Promise.all(roots.map((root) => collectMarkdownFiles(root)))
	).flat()
	return [...new Set(files)].sort()
}
export async function grepMemoryInPaths(
	pi: ExtensionAPI,
	paths: MemoryPaths,
	query: string,
	limit: number = 30,
): Promise<string> {
	const grepRoots = uniquePaths([
		paths.projectDir,
		paths.systemDir,
		paths.rulesDir,
		paths.sessionMemoryDir,
		paths.summariesDir,
	])
	try {
		const result = await pi.exec("rg", [
			"--hidden",
			"--smart-case",
			"--glob",
			"!.git",
			"--glob",
			"!node_modules",
			"--glob",
			"*.md",
			"--files-with-matches",
			"--max-count",
			"1",
			query,
			...grepRoots,
		])
		const matchedFiles = [
			...new Set(
				result.stdout
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter(Boolean),
			),
		]
		if (matchedFiles.length === 0) return "No matches found"
		const selectedFiles = matchedFiles.slice(0, limit)
		const blocks = await Promise.all(
			selectedFiles.map(async (filePath) => {
				const absolutePath = path.isAbsolute(filePath)
					? filePath
					: path.resolve(paths.workTree, filePath)
				const relativePath =
					path.relative(paths.workTree, absolutePath) || absolutePath
				const content = await readFile(absolutePath, "utf8")
				return [`--- ${relativePath} ---`, content.trim() || "(empty)"].join(
					"\n",
				)
			}),
		)
		const combined = [`Matched files: ${matchedFiles.length}`, ...blocks].join(
			"\n\n",
		)
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
