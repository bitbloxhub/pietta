import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { getStorageRoot, sanitizeAgentId } from "./paths.js"
import { DEFAULT_AGENT_ID, type PiettaState } from "./types.js"

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T
	} catch {
		return fallback
	}
}

export async function writeJson(
	filePath: string,
	value: unknown,
): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export function getCurrentAgentIdSync(): string {
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

export async function loadState(): Promise<PiettaState> {
	return readJson<PiettaState>(path.join(getStorageRoot(), "state.json"), {
		currentAgentId: DEFAULT_AGENT_ID,
	})
}

export async function saveState(state: PiettaState): Promise<void> {
	await writeJson(path.join(getStorageRoot(), "state.json"), state)
}

export function getAgentIds(): string[] {
	const agentsDir = path.join(getStorageRoot(), "agents")
	if (!existsSync(agentsDir)) return []
	return readdirSync(agentsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
}
