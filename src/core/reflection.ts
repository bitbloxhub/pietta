import { readFile } from "node:fs/promises"
import path from "node:path"
import { complete } from "@mariozechner/pi-ai"
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	serializeConversation,
} from "@mariozechner/pi-coding-agent"
import { resolveReadPaths } from "./layout.js"
import {
	collectMemoryItemsFromPaths,
	findMemoryItemInPaths,
	getRememberDir,
	parseFrontmatterBlock,
	remember,
	sanitizeRelativeMemoryPath,
	updateMemoryItem,
} from "./memory.js"
import { getProjectSlug } from "./paths.js"
import { loadReflectionConfig, updateReflectionStatus } from "./state.js"
import type { MemoryItem, Scope } from "./types.js"

type ModelRegistryLike = {
	getApiKey?: (model: { provider: string }) => Promise<string | undefined>
	authStorage?: {
		getApiKey?: (providerId: string) => Promise<string | undefined>
	}
}

type ReflectionCompactionPreparation = {
	firstKeptEntryId: string
	tokensBefore: number
	messagesToSummarize: Parameters<typeof convertToLlm>[0]
	turnPrefixMessages: Parameters<typeof convertToLlm>[0]
	previousSummary?: string
}

async function resolveModelApiKey(
	ctx: ExtensionContext,
): Promise<string | undefined> {
	if (!ctx.model) return undefined
	const modelRegistry = ctx.modelRegistry as unknown as ModelRegistryLike
	if (typeof modelRegistry.getApiKey === "function") {
		return modelRegistry.getApiKey(ctx.model)
	}
	if (typeof modelRegistry.authStorage?.getApiKey === "function") {
		return modelRegistry.authStorage.getApiKey(ctx.model.provider)
	}
	return undefined
}

type ReflectionCandidate = {
	scope?: Scope
	kind?: string
	selector?: string
	path?: string
	text?: string
	confidence?: number
}

type ReflectionPlan = {
	reflections?: ReflectionCandidate[]
}

type AppliedReflection = {
	action: "created" | "updated"
	id: string
	filePath: string
}

function extractJsonObject(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
	if (fenced?.[1]) return fenced[1].trim()
	const arrayStart = text.indexOf("[")
	const arrayEnd = text.lastIndexOf("]")
	if (arrayStart !== -1 && arrayEnd > arrayStart) {
		const objectStart = text.indexOf("{")
		if (objectStart === -1 || arrayStart < objectStart) {
			return text.slice(arrayStart, arrayEnd + 1)
		}
	}
	const start = text.indexOf("{")
	const end = text.lastIndexOf("}")
	if (start === -1 || end === -1 || end <= start) return null
	return text.slice(start, end + 1)
}

function normalizeReflectionPlan(value: unknown): ReflectionPlan | null {
	if (!value) return null
	if (Array.isArray(value)) {
		return {
			reflections: value.filter(
				(item) => item && typeof item === "object",
			) as ReflectionCandidate[],
		}
	}
	if (typeof value !== "object") return null
	const plan = value as { reflections?: unknown }
	if (Array.isArray(plan.reflections)) {
		return {
			reflections: plan.reflections.filter(
				(item) => item && typeof item === "object",
			) as ReflectionCandidate[],
		}
	}
	return null
}

async function completeReflectionPlan(
	ctx: ExtensionContext,
	prompt: string,
): Promise<{
	plan: ReflectionPlan | null
	rawText: string
	rawOutput: string
}> {
	if (!ctx.model) return { plan: null, rawText: "", rawOutput: "" }
	const apiKey = await resolveModelApiKey(ctx)

	let currentPrompt = prompt
	let lastText = ""
	let lastOutput = ""

	for (const attempt of [0, 1]) {
		const response = await complete(
			ctx.model,
			{
				systemPrompt: currentPrompt,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Return the reflection result now." },
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				reasoningEffort: "medium",
				...(apiKey ? { apiKey } : {}),
			},
		)
		lastOutput = JSON.stringify(response, null, 2)
		const text = response.content
			.filter(
				(part): part is { type: "text"; text: string } => part.type === "text",
			)
			.map((part) => part.text)
			.join("\n")
		lastText = text
		const jsonText = extractJsonObject(text)
		if (jsonText) {
			try {
				const parsed = JSON.parse(jsonText) as unknown
				const normalized = normalizeReflectionPlan(parsed)
				if (normalized)
					return {
						plan: normalized,
						rawText: text,
						rawOutput: lastOutput,
					}
			} catch {
				// fall through to repair attempt
			}
		}
		if (attempt === 1) break
		currentPrompt = [
			"Your previous response was not valid for the required schema.",
			"Repair it and return valid JSON only.",
			"Allowed outputs:",
			'- {"reflections": []}',
			'- {"reflections": [{"scope":"project"|"agent","kind":"fact","text":"...","confidence":0.9}]}',
			"Previous invalid response:",
			text || "<empty>",
		].join("\n\n")
	}

	return { plan: null, rawText: lastText, rawOutput: lastOutput }
}

function normalizeScope(value: unknown): Scope | null {
	return value === "project" || value === "agent" ? value : null
}

function normalizeConfidence(value: unknown): number {
	if (typeof value !== "number" || Number.isNaN(value)) return 0.9
	return Math.min(1, Math.max(0, value))
}

function truncateText(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function renderMemoryInventory(items: MemoryItem[]): string {
	if (items.length === 0) return "<none>"
	return items
		.map((item) => {
			const body = truncateText(item.body.replace(/\s+/g, " ").trim(), 220)
			return [
				`- id: ${item.id}`,
				`  kind: ${item.kind}`,
				`  path: ${item.filePath}`,
				`  body: ${body || "<empty>"}`,
			].join("\n")
		})
		.join("\n")
}

function summarizeInvalidReflectionOutput(
	text: string,
	rawOutput?: string,
): string {
	const serialized = rawOutput?.trim()
	if (serialized) return serialized
	const trimmed = text.trim()
	if (!trimmed) return "<empty response>"
	return trimmed
}

function buildReflectionDebug(input: {
	preparationKey: string
	preparation: ReflectionCompactionPreparation
	prompt?: string
	plan?: ReflectionPlan | null
	applied?: AppliedReflection[]
	existingMemoryCount: number
	keptRecentCount?: number
}): string {
	return [
		`Preparation key: ${input.preparationKey}`,
		`Messages to summarize: ${input.preparation.messagesToSummarize.length}`,
		`Split turn prefix messages: ${input.preparation.turnPrefixMessages.length}`,
		`Had previous summary: ${input.preparation.previousSummary ? "yes" : "no"}`,
		`Existing memory items considered: ${input.existingMemoryCount}`,
		`Kept recent messages included: ${input.keptRecentCount ?? 0}`,
		"",
		"Prompt:",
		input.prompt?.trim() || "<not built>",
		"",
		"Plan:",
		JSON.stringify(input.plan ?? null, null, 2),
		...(input.applied
			? [
					"",
					"Applied:",
					input.applied.length > 0
						? input.applied
								.map(
									(entry) =>
										`- ${entry.action} ${entry.id} -> ${entry.filePath}`,
								)
								.join("\n")
						: "<none>",
				]
			: []),
	].join("\n")
}

function buildReflectionPrompt(input: {
	agentId: string
	projectSlug: string
	compactionKey: string
	previousSummary?: string
	compactedConversation: string
	turnPrefixConversation: string
	keptRecentConversation: string
	existingMemory: MemoryItem[]
}): string {
	return [
		"You are Pietta's sleep-time reflection engine.",
		"You are reviewing the exact conversation slice that pi is about to compact, plus a bounded tail of kept recent messages and any previous compaction summary.",
		"Propose only durable memory updates worth preserving beyond this compaction.",
		"Focus on stable user preferences, project facts, recurring workflow constraints, and mistakes or corrections worth preserving.",
		"Prefer evidence from the raw messages being compacted first, then the kept recent tail. Use the previous summary only as supporting context.",
		"Never store secrets, credentials, API keys, tokens, or clearly temporary details.",
		"Avoid duplicate notes. Reuse an existing memory item by selector when it already covers the topic.",
		"Prefer at most 5 focused memory updates.",
		"Use scope `agent` for cross-project user or agent preferences. Use scope `project` for project-specific facts and conventions.",
		"For new memories, provide a meaningful slash-separated `path` relative to the chosen memory area, without `.md`.",
		"Filename examples: `user_preferences`, `coding_preferences`, `workflow/testing_notes`, `project_constraints`.",
		"Return JSON only with this shape:",
		'{\n  "reflections": [\n    {\n      "scope": "project" | "agent",\n      "kind": "preference" | "fact" | "workflow" | "constraint" | "mistake" | "decision",\n      "selector"?: "existing memory id to update",\n      "path"?: "new/path_without_md",\n      "text": "durable markdown body",\n      "confidence": 0.0\n    }\n  ]\n}',
		'If nothing durable should be saved, return `{"reflections":[]}`.',
		"Do not emit any prose outside the JSON object.",
		"",
		`Agent: ${input.agentId}`,
		`Project: ${input.projectSlug}`,
		`Compaction key: ${input.compactionKey}`,
		"",
		"## Previous Compaction Summary",
		input.previousSummary?.trim() || "<none>",
		"",
		"## Messages To Summarize",
		input.compactedConversation.trim() || "<empty>",
		"",
		"## Split Turn Prefix Messages",
		input.turnPrefixConversation.trim() || "<none>",
		"",
		"## Kept Recent Messages",
		input.keptRecentConversation.trim() || "<none>",
		"",
		"## Existing Memory Inventory",
		renderMemoryInventory(input.existingMemory),
	].join("\n")
}

function getKeptRecentMessages(
	branchEntries: SessionEntry[],
	firstKeptEntryId: string,
	limit: number = 12,
): ReflectionCompactionPreparation["messagesToSummarize"] {
	const firstKeptIndex = branchEntries.findIndex(
		(entry) => entry.id === firstKeptEntryId,
	)
	if (firstKeptIndex === -1) return []
	return branchEntries
		.slice(firstKeptIndex)
		.filter(
			(
				entry,
			): entry is SessionEntry & {
				type: "message"
				message: ReflectionCompactionPreparation["messagesToSummarize"][number]
			} => entry.type === "message" && "message" in entry,
		)
		.map((entry) => entry.message)
		.slice(-limit)
}

async function getExistingMemoryForReflection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
): Promise<{
	paths: Awaited<ReturnType<typeof resolveReadPaths>>
	items: MemoryItem[]
}> {
	const paths = await resolveReadPaths(pi, ctx, agentId)
	const items = (await collectMemoryItemsFromPaths(paths)).filter(
		(item) => item.scope === "project" || item.scope === "agent",
	)
	return {
		paths,
		items: items.slice(0, 20),
	}
}

async function readCurrentBody(item: MemoryItem): Promise<string> {
	const parsed = parseFrontmatterBlock(await readFile(item.filePath, "utf8"))
	return parsed.body.trim()
}

async function findExistingItemForCandidate(
	paths: Awaited<ReturnType<typeof resolveReadPaths>>,
	candidate: Required<Pick<ReflectionCandidate, "scope" | "kind" | "text">> &
		Pick<ReflectionCandidate, "selector" | "path">,
): Promise<MemoryItem | null> {
	const selector = candidate.selector?.trim()
	if (selector) {
		return findMemoryItemInPaths(paths, selector)
	}

	const relativePath = sanitizeRelativeMemoryPath(candidate.path || "")
	if (!relativePath) return null
	const candidateDirs =
		candidate.scope === "agent"
			? [paths.systemDir]
			: [
					getRememberDir(
						paths,
						candidate.scope,
						candidate.kind,
						candidate.text,
					),
					paths.projectDir,
					paths.projectSystemDir,
				]
	for (const dir of [...new Set(candidateDirs)]) {
		const filePath = path.join(dir, `${relativePath}.md`)
		const found = await findMemoryItemInPaths(paths, filePath)
		if (found) return found
	}
	return null
}

async function applyReflectionCandidate(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
	paths: Awaited<ReturnType<typeof resolveReadPaths>>,
	candidate: ReflectionCandidate,
	source: string,
): Promise<AppliedReflection | null> {
	const scope = normalizeScope(candidate.scope)
	const text = candidate.text?.trim()
	const kind = candidate.kind?.trim() || "fact"
	if (!scope || !text) return null

	const existing = await findExistingItemForCandidate(paths, {
		scope,
		kind,
		selector: candidate.selector,
		path: candidate.path,
		text,
	})
	if (existing) {
		const currentBody = await readCurrentBody(existing)
		if (currentBody === text) return null
		const updated = await updateMemoryItem(
			pi,
			ctx,
			agentId,
			existing.id,
			text,
			{
				mode: "replace",
				source,
			},
		)
		return {
			action: "updated",
			id: updated.id,
			filePath: updated.filePath,
		}
	}

	const relativePath = sanitizeRelativeMemoryPath(candidate.path || "")
	const filePath = await remember(pi, ctx, agentId, {
		text,
		scope,
		kind,
		confidence: normalizeConfidence(candidate.confidence),
		source,
		path: relativePath || undefined,
	})
	const created = await findMemoryItemInPaths(paths, filePath)
	return {
		action: "created",
		id: created?.id || `${scope}/${relativePath || "memory_entry"}`,
		filePath,
	}
}

function buildPreparationKey(
	preparation: ReflectionCompactionPreparation,
): string {
	return [
		preparation.firstKeptEntryId,
		preparation.tokensBefore,
		preparation.messagesToSummarize.length,
		preparation.turnPrefixMessages.length,
	].join(":")
}

function serializeReflectionMessages(
	messages: ReflectionCompactionPreparation["messagesToSummarize"],
): string {
	if (messages.length === 0) return ""
	return serializeConversation(convertToLlm(messages))
}

export async function runSleepTimeReflectionForCompaction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
	preparation: ReflectionCompactionPreparation,
	branchEntries: SessionEntry[],
): Promise<void> {
	const config = await loadReflectionConfig(agentId)
	if (config.trigger === "off") return

	const preparationKey = buildPreparationKey(preparation)
	if (config.lastReflectionKey === preparationKey) {
		await updateReflectionStatus(
			agentId,
			"skipped",
			`Skipped duplicate reflection for compaction preparation ${preparationKey}`,
			{
				lastReflectionDebug: buildReflectionDebug({
					preparationKey,
					preparation,
					existingMemoryCount: 0,
					keptRecentCount: 0,
				}),
			},
		)
		return
	}
	if (!ctx.model) {
		const message = "Sleep-time reflection skipped: no active model selected"
		await updateReflectionStatus(agentId, "error", message, {
			lastReflectionDebug: buildReflectionDebug({
				preparationKey,
				preparation,
				existingMemoryCount: 0,
				keptRecentCount: 0,
			}),
		})
		ctx.ui.notify(message, "warning")
		return
	}

	ctx.ui.notify("Pietta sleep-time reflection started", "info")
	const { paths, items } = await getExistingMemoryForReflection(
		pi,
		ctx,
		agentId,
	)
	const keptRecentMessages = getKeptRecentMessages(
		branchEntries,
		preparation.firstKeptEntryId,
	)
	const prompt = buildReflectionPrompt({
		agentId,
		projectSlug: getProjectSlug(ctx.cwd),
		compactionKey: preparationKey,
		previousSummary: preparation.previousSummary,
		compactedConversation: serializeReflectionMessages(
			preparation.messagesToSummarize,
		),
		turnPrefixConversation: serializeReflectionMessages(
			preparation.turnPrefixMessages,
		),
		keptRecentConversation: serializeReflectionMessages(keptRecentMessages),
		existingMemory: items,
	})
	const { plan, rawText, rawOutput } = await completeReflectionPlan(ctx, prompt)
	if (!plan) {
		const message = [
			"Sleep-time reflection failed: model did not return valid JSON",
			"",
			"Model output:",
			summarizeInvalidReflectionOutput(rawText, rawOutput),
		].join("\n")
		await updateReflectionStatus(agentId, "error", message, {
			lastReflectionDebug: buildReflectionDebug({
				preparationKey,
				preparation,
				prompt,
				plan,
				existingMemoryCount: items.length,
				keptRecentCount: keptRecentMessages.length,
			}),
		})
		ctx.ui.notify(message, "warning")
		return
	}

	const applied: AppliedReflection[] = []
	const source = `reflection:compaction:${preparationKey}`
	for (const candidate of plan.reflections?.slice(0, 5) ?? []) {
		const result = await applyReflectionCandidate(
			pi,
			ctx,
			agentId,
			paths,
			candidate,
			source,
		)
		if (result) applied.push(result)
	}

	if (applied.length === 0) {
		const message = "Sleep-time reflection completed with no new durable memory"
		await updateReflectionStatus(agentId, "skipped", message, {
			lastReflectionKey: preparationKey,
			lastReflectionDebug: buildReflectionDebug({
				preparationKey,
				preparation,
				prompt,
				plan,
				applied,
				existingMemoryCount: items.length,
				keptRecentCount: keptRecentMessages.length,
			}),
		})
		ctx.ui.notify(message, "info")
		return
	}

	const summary = [
		`Sleep-time reflection stored ${applied.length} ${applied.length === 1 ? "memory update" : "memory updates"}`,
		...applied.map((entry) => `- ${entry.action} ${entry.id}`),
	].join("\n")
	await updateReflectionStatus(agentId, "success", summary, {
		lastReflectionKey: preparationKey,
		lastReflectionDebug: buildReflectionDebug({
			preparationKey,
			preparation,
			prompt,
			plan,
			applied,
			existingMemoryCount: items.length,
			keptRecentCount: keptRecentMessages.length,
		}),
	})
	ctx.ui.notify(summary, "info")
}
