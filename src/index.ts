import {
	access,
	appendFile,
	mkdir,
	readdir,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises"
import { constants, existsSync, readFileSync, readdirSync } from "node:fs"
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
function getStorageRoot(): string {
	return path.join(homedir(), ".pi", "pietta")
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
function getPaths(cwd: string, agentId: string): MemoryPaths {
	const root = getStorageRoot()
	const agentsDir = path.join(root, "agents")
	const agentDir = path.join(agentsDir, agentId)
	const workTree = path.join(agentDir, "memory")
	const projectDir = path.join(workTree, "projects", getProjectSlug(cwd))
	const rulesDir = path.join(workTree, "rules")

	return {
		root,
		stateFile: path.join(root, "state.json"),
		agentsDir,
		agentDir,
		bareRepo: path.join(agentDir, "memory.git"),
		workTree,
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
function getMemoryCommandCompletions(
	prefix: string,
): AutocompleteItem[] | null {
	const trimmed = prefix.trimStart()
	const endsWithSpace = /\s$/.test(prefix)
	const parts = trimmed.split(/\s+/).filter(Boolean)
	const command = parts[0] ?? ""
	const commands = ["list", "recent", "show", "grep", "update", "delete"]
	const memoryIds = getMemoryItemIdsSync(process.cwd(), getCurrentAgentIdSync())
	if (!trimmed) return commands.map((value) => ({ value, label: value }))
	if (parts.length === 1 && !endsWithSpace)
		return toAutocompleteItems(commands, command)
	if (["show", "update", "delete"].includes(command)) {
		const selectorPrefix = endsWithSpace ? "" : parts.slice(1).join(" ")
		return toAutocompleteItems(memoryIds, selectorPrefix, `${command} `)
	}
	return null
}
function getRuleFileIds(agentId: string, cwd: string): string[] {
	const paths = getPaths(cwd, agentId)
	if (!existsSync(paths.rulesDir)) return []
	const files: string[] = []
	const stack: Array<{ dir: string; relative: string }> = [
		{ dir: paths.rulesDir, relative: "" },
	]
	while (stack.length > 0) {
		const current = stack.pop()
		if (!current) continue
		for (const entry of readdirSync(current.dir, { withFileTypes: true })) {
			const fullPath = path.join(current.dir, entry.name)
			const relativePath = current.relative
				? path.join(current.relative, entry.name)
				: entry.name
			if (entry.isDirectory()) {
				stack.push({ dir: fullPath, relative: relativePath })
				continue
			}
			if (entry.isFile() && entry.name.endsWith(".md")) files.push(relativePath)
		}
	}

	return files.sort()
}

function getRulesCommandCompletions(prefix: string): AutocompleteItem[] | null {
	return toAutocompleteItems(
		getRuleFileIds(getCurrentAgentIdSync(), process.cwd()),
		prefix,
	)
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
): Promise<EnsureResult> {
	const paths = getPaths(cwd, agentId)
	const created: string[] = []
	for (const dir of [paths.root, paths.agentsDir, paths.agentDir]) {
		await ensureDir(dir, created)
	}

	if (!(await exists(paths.bareRepo))) {
		await pi.exec("git", ["init", "--bare", paths.bareRepo])
		created.push(paths.bareRepo)
	}

	if (!(await exists(paths.workTree))) {
		await pi.exec("git", ["clone", paths.bareRepo, paths.workTree], { cwd })
		created.push(paths.workTree)
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
		await ensureDir(dir, created)
	}

	for (const [filePath, content] of Object.entries(
		getDefaultFiles(cwd, agentId, paths),
	)) {
		await ensureFile(filePath, content, created)
	}

	return { paths, created }
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
	const { paths } = await ensureAgentLayout(pi, ctx.cwd, agentId)
	const now = new Date().toISOString()
	const source =
		input.source?.trim() || ctx.sessionManager.getSessionFile() || "ephemeral"
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
		sources: [source],
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
		source,
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
		source,
	})
	return filePath
}
async function collectMemoryItems(
	pi: ExtensionAPI,
	cwd: string,
	agentId: string,
): Promise<MemoryItem[]> {
	const { paths } = await ensureAgentLayout(pi, cwd, agentId)
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
async function findMemoryItem(
	pi: ExtensionAPI,
	cwd: string,
	agentId: string,
	selector: string,
): Promise<MemoryItem | null> {
	const normalized = selector.trim()
	if (!normalized) return null
	const items = await collectMemoryItems(pi, cwd, agentId)
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
async function updateMemoryItem(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
	selector: string,
	text: string,
	options?: { mode?: "replace" | "append"; source?: string },
): Promise<MemoryItem> {
	const item = await findMemoryItem(pi, ctx.cwd, agentId, selector)
	if (!item) throw new Error(`Could not find memory item: ${selector}`)

	const parsed = parseFrontmatterBlock(await readFile(item.filePath, "utf8"))
	const now = new Date().toISOString()
	const source =
		options?.source?.trim() ||
		ctx.sessionManager.getSessionFile() ||
		"ephemeral"
	const sources = new Set(
		Array.isArray(parsed.data.sources) ? parsed.data.sources : [],
	)
	sources.add(source)
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
	const { paths } = await ensureAgentLayout(pi, ctx.cwd, agentId)
	await appendTimeline(paths, {
		id: item.id,
		timestamp: now,
		action: "update",
		agent: agentId,
		file: item.filePath,
		mode: options?.mode ?? "replace",
		source,
	})

	return {
		...item,
		body: nextBody,
		updatedAt: now,
		sources: [...sources],
	}
}
async function deleteMemoryItem(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
	selector: string,
): Promise<MemoryItem> {
	const item = await findMemoryItem(pi, ctx.cwd, agentId, selector)
	if (!item) throw new Error(`Could not find memory item: ${selector}`)
	await unlink(item.filePath)
	const { paths } = await ensureAgentLayout(pi, ctx.cwd, agentId)
	const now = new Date().toISOString()
	const source = ctx.sessionManager.getSessionFile() || "ephemeral"
	await appendTimeline(paths, {
		id: item.id,
		timestamp: now,
		action: "delete",
		agent: agentId,
		file: item.filePath,
		source,
	})
	await appendCandidates(paths, {
		id: item.id,
		timestamp: now,
		action: "delete",
		agent: agentId,
		file: item.filePath,
		source,
	})
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
async function grepMemory(
	pi: ExtensionAPI,
	cwd: string,
	agentId: string,
	query: string,
	limit: number = 30,
): Promise<string> {
	const { paths } = await ensureAgentLayout(pi, cwd, agentId)
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
async function renderMemoryOverview(
	pi: ExtensionAPI,
	cwd: string,
	agentId: string,
): Promise<string> {
	const { paths } = await ensureAgentLayout(pi, cwd, agentId)
	const recentFiles = await getRecentFiles(paths.workTree, 8)
	const rules = await collectMarkdownFiles(paths.rulesDir)
	return [
		`Agent: ${agentId}`,
		`Memory root: ${paths.workTree}`,
		`Project summary: ${paths.projectSummaryFile}`,
		`Latest summary: ${paths.latestSummaryFile}`,
		`Rules: ${rules.length}`,
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
	if (command === "show" || command === "delete")
		return { command, selector: rest.join(" ") || undefined }
	if (command === "update")
		return { command, selector: rest[0], text: rest.slice(1).join(" ") }
	if (command === "grep" || command === "search")
		return { command: "grep", text: rest.join(" ") }
	if (command === "list" || command === "recent") return { command }
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
	pi.registerCommand("init", {
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
	pi.registerCommand("doctor", {
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
		description: "Inspect, show, grep, update, or delete Pietta memory",
		getArgumentCompletions: getMemoryCommandCompletions,
		handler: async (args, ctx) => {
			await syncState()
			const parsed = parseMemoryArgs(args)
			if (parsed.command === "list" || parsed.command === "recent") {
				ctx.ui.notify(
					renderMemoryList(
						await collectMemoryItems(pi, ctx.cwd, currentAgentId),
						20,
					),
					"info",
				)
				return
			}
			if (parsed.command === "show") {
				if (!parsed.selector) {
					ctx.ui.notify("Usage: /memory show <id>", "warning")
					return
				}
				const item = await findMemoryItem(
					pi,
					ctx.cwd,
					currentAgentId,
					parsed.selector,
				)
				ctx.ui.notify(
					item
						? renderMemoryItem(item)
						: `No memory item found for ${parsed.selector}`,
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
			if (parsed.command === "grep") {
				const query = parsed.text?.trim() || ""
				if (!query) {
					ctx.ui.notify(
						"Usage: /memory grep <query>  (use it like ripgrep: plain text or regex query)",
						"warning",
					)
					return
				}
				ctx.ui.notify(
					await grepMemory(pi, ctx.cwd, currentAgentId, query, 50),
					"info",
				)
				return
			}
			ctx.ui.notify(
				"Usage: /memory <list|recent|show|grep|update|delete>",
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
			return {
				content: [
					{
						type: "text",
						text: await grepMemory(
							pi,
							ctx.cwd,
							agentId,
							params.query,
							params.limit ?? 30,
						),
					},
				],
				details: { agentId, query: params.query },
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
