import { StringEnum } from "@mariozechner/pi-ai"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import {
	deleteMemoryItem,
	grepMemoryInPaths,
	remember,
	updateMemoryItem,
} from "../core/memory.js"
import { resolveReadPaths } from "../core/layout.js"
import { sanitizeAgentId } from "../core/paths.js"
import { SCOPE_VALUES } from "../core/types.js"

export function registerTools(
	pi: ExtensionAPI,
	getCurrentAgentId: () => string,
	syncState: () => Promise<void>,
) {
	pi.registerTool({
		name: "pietta_grep_memory",
		label: "Pietta Grep Memory",
		description:
			"Search Pietta markdown memory with ripgrep-style text or regex and return the full contents of each matching file",
		promptSnippet:
			"Use pietta_grep_memory like ripgrep: pass plain text or regex directly to find matching durable notes, preferences, rules, and prior decisions, then inspect the full matching files it returns",
		promptGuidelines: [
			"Use this tool exactly like ripgrep: pass the search pattern directly as the query.",
			"The query can be plain text or a regular expression, just like rg.",
			"This tool returns full matching markdown files, not line snippets.",
			"It does not search timeline jsonl files.",
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
					description: "Maximum matching files to return",
					minimum: 1,
					maximum: 200,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await syncState()
			const agentId = sanitizeAgentId(params.agentId || getCurrentAgentId())
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
			"Write durable memory entries into the Pietta agent memory repo, preferring pinned system areas for agent memory and project system areas for high-priority project memory. Split distinct topics into multiple focused memories, and keep each memory to roughly a paragraph or two when possible",
		promptSnippet:
			"Store durable memory aggressively, especially explicit user preferences, recurring constraints, and stable workflow notes in pinned system memory or project system memory when appropriate. If you pass `path`, make it a memory-local subpath like `preferences/coding_preferences`, not a full repo path like `projects/<slug>/README.md`",
		promptGuidelines: [
			"Always write durable memory when the user explicitly states a preference, default, recurring workflow, or standing constraint.",
			"Do not wait for the user to ask to remember it if the preference is stated clearly.",
			"Use this only for durable facts, preferences, rules, decisions, and environment constraints.",
			"Do not store speculative assumptions, temporary plans, secrets, or credentials.",
			"For project-scoped memories, prefer project system memory for durable project rules and conventions, and ordinary project memory for normal facts.",
			"If you provide `path`, it must be a slash-separated path relative to the chosen memory area, without `.md`, and not a full repo path.",
			"Do not target scaffold files like `README.md` in `projects/<slug>/`, `system/`, or `rules/`; create or update real memory files instead.",
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
			path: Type.Optional(
				Type.String({
					description:
						"Optional slash-separated memory-local subpath like `preferences/coding_preferences`; do not pass full repo paths such as `projects/<slug>/README.md` or include `.md`",
				}),
			),
			agentId: Type.Optional(
				Type.String({ description: "Optional agent ID override" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await syncState()
			const agentId = sanitizeAgentId(params.agentId || getCurrentAgentId())
			const filePath = await remember(pi, ctx, agentId, {
				text: params.text,
				scope: params.scope ?? "project",
				kind: params.kind?.trim() || "fact",
				confidence: params.confidence ?? 0.9,
				source: params.source,
				path: params.path,
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
		promptSnippet:
			"Update an existing Pietta memory entry by its memory id. If you use a filename or path instead of an id, include the `.md` extension. Prefer ids returned by list/show/grep results, not guessed repo paths or scaffold README files",
		promptGuidelines: [
			"Use this when the user wants to revise or correct an existing durable memory item.",
			"Prefer the exact memory id from Pietta output, such as `project/user_preferences`.",
			"If you use a filename or full path selector instead of an id, include the `.md` extension.",
			"Do not guess selectors from repo layout. Avoid paths like `projects/<slug>/README.md`, which are scaffold or summary files rather than normal memory items.",
			"If you are not sure which item to update, grep or list first, then use the returned id.",
		],
		parameters: Type.Object({
			selector: Type.String({
				description:
					"Memory id preferred; filename or full path only when you already know it points to a real memory item, and those path-based selectors should include the `.md` extension. Do not use scaffold paths like `projects/<slug>/README.md`",
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
			const agentId = sanitizeAgentId(params.agentId || getCurrentAgentId())
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
		promptSnippet:
			"Delete an existing Pietta memory entry by its memory id. If you use a filename or path instead of an id, include the `.md` extension. Prefer ids from Pietta results, not guessed repo paths or scaffold README files",
		promptGuidelines: [
			"Use this when the user explicitly wants a memory item forgotten or removed.",
			"Prefer the exact memory id from Pietta output.",
			"If you use a filename or full path selector instead of an id, include the `.md` extension.",
			"Do not guess selectors from repo layout or use scaffold files like `projects/<slug>/README.md`.",
			"If you are unsure which item to delete, grep or list first, then delete by id.",
		],
		parameters: Type.Object({
			selector: Type.String({
				description:
					"Memory id preferred; filename or full path only when you already know it points to a real memory item, and those path-based selectors should include the `.md` extension. Do not use scaffold paths like `projects/<slug>/README.md`",
			}),
			agentId: Type.Optional(
				Type.String({ description: "Optional agent ID override" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await syncState()
			const agentId = sanitizeAgentId(params.agentId || getCurrentAgentId())
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
