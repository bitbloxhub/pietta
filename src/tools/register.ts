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
			const agentId = sanitizeAgentId(params.agentId || getCurrentAgentId())
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
