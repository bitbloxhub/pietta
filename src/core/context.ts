import path from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { truncateHead } from "@mariozechner/pi-coding-agent"
import { ensureAgentLayout } from "./layout.js"
import {
	collectMarkdownFiles,
	EMPTY_LATEST_SUMMARY,
	getRuleRoots,
	readFirstPresentFile,
} from "./memory.js"
function isScaffoldReadme(
	paths: Awaited<ReturnType<typeof ensureAgentLayout>>["paths"],
	filePath: string,
): boolean {
	return (
		filePath === path.join(paths.systemDir, "README.md") ||
		filePath === path.join(paths.projectSystemDir, "README.md") ||
		filePath === path.join(paths.projectRulesDir, "README.md") ||
		filePath === path.join(paths.agentRulesDir, "README.md") ||
		filePath === path.join(paths.generatedRulesDir, "README.md")
	)
}
export async function buildInjectedContext(
	pi: ExtensionAPI,
	cwd: string,
	agentId: string,
): Promise<string | null> {
	const { paths } = await ensureAgentLayout(pi, cwd, agentId)
	const projectSummary = (
		await readFirstPresentFile([paths.projectSummaryFile])
	)?.trim()
	const latestSummary = (
		await readFirstPresentFile([paths.latestSummaryFile])
	)?.trim()
	const systemFiles = await collectMarkdownFiles(paths.systemDir)
	const projectSystemFiles = await collectMarkdownFiles(paths.projectSystemDir)
	const ruleRoots = getRuleRoots(paths)
	const rulePaths = (
		await Promise.all(
			ruleRoots.map(async (root) => {
				const files = await collectMarkdownFiles(root)
				return files
					.map((file) => path.join(root, file))
					.filter((filePath) => !isScaffoldReadme(paths, filePath))
			}),
		)
	).flat()
	const pinnedEntries = [
		...systemFiles.map((file) => ({
			label: `system/${file}`,
			filePath: path.join(paths.systemDir, file),
		})),
		...projectSystemFiles.map((file) => ({
			label: `projects/<slug>/system/${file}`,
			filePath: path.join(paths.projectSystemDir, file),
		})),
	]
	const pinnedSystemSnippets = (
		await Promise.all(
			pinnedEntries
				.filter(({ filePath }) => !isScaffoldReadme(paths, filePath))
				.slice(0, 12)
				.map(async ({ label, filePath }) => {
					const content = (await readFirstPresentFile([filePath]))?.trim()
					if (!content) return null
					return `### ${label}\n${content}`
				}),
		)
	).filter(Boolean) as string[]
	const memoryTreeLines = pinnedEntries
		.filter(({ filePath }) => !isScaffoldReadme(paths, filePath))
		.map(({ label }) => `- ${label}`)
	const blocks = [
		"# Pietta Context",
		`- agent: ${agentId}`,
		`- memory_root: ${paths.workTree}`,
		"",
		"## Memory Discipline",
		"- Treat explicit user preferences as durable memory.",
		"- If the user says something is their preference, default, usual workflow, or recurring constraint, store it in Pietta memory.",
		"- `system/` is pinned high-priority memory, but Pietta does not prescribe internal subfolders there.",
		"- `projects/<slug>/` is project-scoped memory, but Pietta does not prescribe internal subfolders there either.",
		"- Do this proactively without asking for confirmation unless the user says not to remember it.",
		"- Never store secrets, credentials, or clearly temporary details.",
		"",
		"## Hierarchy",
		`- pinned system root: ${paths.systemDir}`,
		`- project root: ${paths.projectDir}`,
		`- project system root: ${paths.projectSystemDir}`,
		`- session root: ${paths.sessionMemoryDir}`,
		`- shared rules root: ${paths.rulesDir}`,
		`- project rules root: ${paths.projectRulesDir}`,
	]
	if (projectSummary) blocks.push(`## Project Summary\n${projectSummary}`)
	if (latestSummary && latestSummary !== EMPTY_LATEST_SUMMARY)
		blocks.push(`## Latest Summary\n${latestSummary}`)
	if (pinnedSystemSnippets.length > 0)
		blocks.push(`## Pinned System Memory\n${pinnedSystemSnippets.join("\n\n")}`)
	if (rulePaths.length > 0)
		blocks.push(
			`## Available Rules\n${rulePaths.map((file) => `- ${file}`).join("\n")}`,
		)
	if (memoryTreeLines.length > 0)
		blocks.push(`## Memory Tree\n${memoryTreeLines.join("\n")}`)
	return (
		truncateHead(blocks.join("\n\n"), {
			maxBytes: 12_000,
			maxLines: 300,
		}).content.trim() || null
	)
}
