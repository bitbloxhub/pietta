import path from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { truncateHead } from "@mariozechner/pi-coding-agent"
import { ensureAgentLayout } from "./layout.js"
import { collectMarkdownFiles, readFileIfPresent } from "./memory.js"

export async function buildInjectedContext(
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
