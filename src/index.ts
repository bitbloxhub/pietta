import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent"
import { buildInjectedContext } from "./core/context.js"
import { ensureAgentLayout } from "./core/layout.js"
import { sanitizeAgentId } from "./core/paths.js"
import { loadState, saveState } from "./core/state.js"
import { DEFAULT_AGENT_ID, EXTENSION_NAME } from "./core/types.js"
import { registerCommands } from "./commands/register.js"
import { registerTools } from "./tools/register.js"

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

	function getCurrentAgentId(): string {
		return currentAgentId
	}

	const { deleteSessionWorktreeForAgent: cleanupSessionWorktrees } =
		registerCommands(pi, getCurrentAgentId, syncState, setCurrentAgent)
	registerTools(pi, getCurrentAgentId, syncState)
	pi.on("session_start", async (_event, ctx) => {
		await syncState()
		await ensureAgentLayout(pi, ctx.cwd, currentAgentId)
		ctx.ui.setStatus(
			EXTENSION_NAME,
			ctx.ui.theme.fg("accent", `pietta:${currentAgentId}`),
		)
	})

	pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
		await syncState()
		const failures = await cleanupSessionWorktrees(ctx)
		for (const failure of failures) {
			ctx.ui.notify(
				`Failed to clean up Pietta session worktree for ${failure.agentId}: ${failure.message}`,
				"warning",
			)
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
}
