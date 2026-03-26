import { complete } from "@mariozechner/pi-ai"
import type { ExtensionContext } from "@mariozechner/pi-coding-agent"
import type { RememberArgs, Scope } from "./types.js"

type ContentBlock = {
	type?: string
	text?: string
	name?: string
	arguments?: Record<string, unknown>
}

type SessionEntryLike = {
	type: string
	message?: {
		role?: string
		content?: unknown
	}
}

type RememberInference = {
	text: string
	scope: Scope
	kind: string
	path?: string
}

const LETTA_STYLE_REMEMBER_PROMPT = `# Memory Request

The user has invoked the /remember command, which indicates they want you to commit something to memory.

## What This Means

The user wants you to use your memory tools to remember information from the conversation. This could be:

- A correction
- A preference
- A fact
- A rule

## Your Task
1. Identify what to remember from the recent conversation context. If the user provided text after /remember, that is a strong hint, but you should still rewrite it into concise durable memory.
2. Determine the right memory block and placement. Choose scope, kind, and an optional nested slash-separated path.
3. Split distinct topics across multiple memory files when appropriate instead of stuffing unrelated things into one note.
4. Keep each memory focused and short — ideally a paragraph or two.
5. Use Pietta memory tools to store it.
6. Briefly confirm what you remembered and where you stored it.
- NEVER write directly to memory files yourself in this flow; use Pietta memory tools instead.
- Be concise and distill the information to its essence
- Avoid duplicates and overly transient details
- Match the intent of a durable memory edit, not a raw transcript dump
- Prefer multiple small focused memories over one large catch-all memory
- If the request is unclear, ask for clarification instead of inventing details
`

export function buildRememberCommandPrompt(args?: RememberArgs): string {
	const normalizedText = args?.text?.trim()
	const placementHints = [
		args?.scopeExplicit
			? `The user explicitly selected scope: ${args.scope}`
			: "",
		args?.path ? `The user explicitly selected path: ${args.path}` : "",
	]
		.filter(Boolean)
		.join("\n")
	return [
		LETTA_STYLE_REMEMBER_PROMPT,
		"The user explicitly invoked /remember. Use Pietta memory tools to store the durable memory in the right hierarchy.",
		placementHints,
		normalizedText
			? `The user provided this hint after /remember: ${normalizedText}`
			: "The user did not provide text after /remember. Infer the durable memory from recent conversation context.",
		args?.scopeExplicit
			? "Respect the user's explicit scope unless you truly need clarification."
			: "",
		args?.path
			? "Respect the user's explicit slash-separated path unless you truly need clarification. Apply only normal filename sanitization if you store memory there."
			: "",
		"Rewrite the memory into concise durable form instead of copying raw user text verbatim when a cleaner memory note would be better.",
		"After updating memory, briefly confirm what you remembered and where you stored it.",
	]
		.filter(Boolean)
		.join("\n\n")
}

const LETTA_STYLE_INIT_PROMPT = `# Memory Initialization Request
The user has invoked /pietta-init. This means they want a deeper, interactive memory initialization or re-analysis pass for the current project.

A shallow Pietta bootstrap may already have created starter files. Treat this turn like Letta Code's manual /init flow: inspect what exists, refine it, fill obvious gaps, and organize memory into a useful filesystem shape.
## Your Task
1. Inspect the current project and existing Pietta memory.
2. Refine existing memory in place when it already covers a topic instead of creating duplicates.
3. Create or update a small useful project memory skeleton where needed.
4. Ask follow-up questions only if important memory gaps are obvious and you genuinely need clarification.
5. Split distinct topics across multiple memories when appropriate instead of stuffing unrelated things into one file.
6. Keep each memory focused and short — ideally a paragraph or two.
7. Use \`projects/<slug>/system/\` for project-pinned guidance and \`projects/<slug>/\` for ordinary project memory unless a different nested path is clearly better.
8. Briefly confirm what you initialized or updated.
- NEVER write directly to memory files yourself in this flow; use Pietta memory tools instead.
- Prefer a small, useful skeleton over a large dump
- Avoid duplicates and unnecessary rewrites
- Refine memory if it has drifted instead of redoing everything blindly
- Leave room for the memory tree to grow over time
`
export function buildPiettaInitCommandPrompt(): string {
	return [
		LETTA_STYLE_INIT_PROMPT,
		"The user explicitly invoked /pietta-init. Perform the deeper interactive init pass now.",
		"If the current memory already has the right structure, refine and extend it instead of recreating it.",
		"After updating memory, briefly confirm what you initialized and where you stored it.",
	].join("\n\n")
}

function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") return [content]
	if (!Array.isArray(content)) return []

	const textParts: string[] = []
	for (const part of content) {
		if (!part || typeof part !== "object") continue
		const block = part as ContentBlock
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text)
		}
	}
	return textParts
}

function extractToolCallLines(content: unknown): string[] {
	if (!Array.isArray(content)) return []

	const toolCalls: string[] = []
	for (const part of content) {
		if (!part || typeof part !== "object") continue
		const block = part as ContentBlock
		if (block.type !== "toolCall" || typeof block.name !== "string") continue
		toolCalls.push(
			`Tool ${block.name} was called with args ${JSON.stringify(block.arguments ?? {})}`,
		)
	}
	return toolCalls
}

export function buildConversationText(
	entries: SessionEntryLike[],
	maxMessages: number = 12,
): string {
	const relevantEntries = entries.filter(
		(entry) =>
			entry.type === "message" &&
			(entry.message?.role === "user" || entry.message?.role === "assistant"),
	)
	const sections: string[] = []

	for (const entry of relevantEntries.slice(-maxMessages)) {
		const role = entry.message?.role
		if (!role) continue
		const isUser = role === "user"
		const isAssistant = role === "assistant"
		const entryLines: string[] = []
		const textParts = extractTextParts(entry.message?.content)
		if (textParts.length > 0) {
			const messageText = textParts.join("\n").trim()
			if (messageText)
				entryLines.push(`${isUser ? "User" : "Assistant"}: ${messageText}`)
		}
		if (isAssistant)
			entryLines.push(...extractToolCallLines(entry.message?.content))
		if (entryLines.length > 0) sections.push(entryLines.join("\n"))
	}

	return sections.join("\n\n")
}

function extractJsonObject(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
	if (fenced?.[1]) return fenced[1].trim()
	const start = text.indexOf("{")
	const end = text.lastIndexOf("}")
	if (start === -1 || end === -1 || end <= start) return null
	return text.slice(start, end + 1)
}

async function completeJson<T>(
	ctx: ExtensionContext,
	prompt: string,
): Promise<T | null> {
	if (!ctx.model) return null
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model)
	if (!apiKey) return null

	const response = await complete(
		ctx.model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey, reasoningEffort: "medium" },
	)
	const text = response.content
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("\n")
	const jsonText = extractJsonObject(text)
	if (!jsonText) return null
	try {
		return JSON.parse(jsonText) as T
	} catch {
		return null
	}
}

function normalizeInferredScope(value: unknown, fallback: Scope): Scope {
	return value === "project" || value === "agent" || value === "session"
		? value
		: fallback
}

function normalizeOptionalPath(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export async function inferRememberInputFromContext(
	ctx: ExtensionContext,
	defaults?: Partial<RememberInference> & {
		scopeExplicit?: boolean
		commandText?: string
	},
): Promise<RememberInference | null> {
	const branch = ctx.sessionManager.getBranch() as SessionEntryLike[]
	const conversationText = buildConversationText(branch)
	if (!conversationText.trim() && !defaults?.commandText?.trim()) return null
	const inferred = await completeJson<RememberInference>(
		ctx,
		[
			LETTA_STYLE_REMEMBER_PROMPT,
			defaults?.scopeExplicit && defaults.scope
				? `Use scope ${defaults.scope} exactly.`
				: "Infer the best scope from the conversation.",
			defaults?.path
				? `Prefer this path if it still fits: ${defaults.path}`
				: "",
			defaults?.kind ? `Prefer kind ${defaults.kind}.` : "",
			defaults?.commandText?.trim()
				? `User text after /remember: ${defaults.commandText.trim()}`
				: "User text after /remember: <none>",
			"",
			"<conversation>",
			conversationText,
			"</conversation>",
		]
			.filter(Boolean)
			.join("\n"),
	)
	if (!inferred?.text?.trim()) return null
	return {
		text: inferred.text.trim(),
		scope: normalizeInferredScope(inferred.scope, defaults?.scope ?? "project"),
		kind:
			typeof inferred.kind === "string" && inferred.kind.trim()
				? inferred.kind.trim()
				: defaults?.kind?.trim() || "fact",
		path: normalizeOptionalPath(inferred.path ?? defaults?.path),
	}
}
