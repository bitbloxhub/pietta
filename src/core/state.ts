import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@mariozechner/pi-coding-agent"
import { getStorageRoot, sanitizeAgentId } from "./paths.js"
import {
	DEFAULT_AGENT_ID,
	DEFAULT_REFLECTION_TRIGGER,
	type PiettaState,
	type ReflectionConfig,
	type ReflectionStatus,
} from "./types.js"

const PIETTA_SESSION_STATE_TYPE = "pietta-state"

type PiettaSessionState = {
	currentAgentId?: string
}

function getAgentStateDir(agentId: string): string {
	return path.join(getStorageRoot(), "agents", sanitizeAgentId(agentId))
}

function getReflectionConfigPath(agentId: string): string {
	return path.join(getAgentStateDir(agentId), "reflection.json")
}

function getDefaultReflectionConfig(): ReflectionConfig {
	return {
		trigger: DEFAULT_REFLECTION_TRIGGER,
		lastReflectionStatus: "idle",
	}
}

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

export async function loadReflectionConfig(
	agentId: string,
): Promise<ReflectionConfig> {
	const config = await readJson<
		ReflectionConfig & { lastReflectedCompactionId?: string }
	>(getReflectionConfigPath(agentId), getDefaultReflectionConfig())
	return {
		...getDefaultReflectionConfig(),
		...config,
		lastReflectionKey:
			config.lastReflectionKey ?? config.lastReflectedCompactionId,
		trigger: config.trigger === "off" ? "off" : DEFAULT_REFLECTION_TRIGGER,
	}
}

export async function saveReflectionConfig(
	agentId: string,
	config: ReflectionConfig,
): Promise<void> {
	await writeJson(getReflectionConfigPath(agentId), {
		...getDefaultReflectionConfig(),
		...config,
	})
}

export async function updateReflectionStatus(
	agentId: string,
	status: ReflectionStatus,
	message: string,
	extra?: Partial<ReflectionConfig>,
): Promise<ReflectionConfig> {
	const current = await loadReflectionConfig(agentId)
	const next: ReflectionConfig = {
		...current,
		...extra,
		lastReflectionAt: new Date().toISOString(),
		lastReflectionStatus: status,
		lastReflectionMessage: message,
	}
	await saveReflectionConfig(agentId, next)
	return next
}

function getSessionStateEntry(
	entries: SessionEntry[],
): PiettaSessionState | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]
		if (
			entry.type !== "custom" ||
			entry.customType !== PIETTA_SESSION_STATE_TYPE
		)
			continue
		return (entry.data ?? null) as PiettaSessionState | null
	}

	return null
}

export function loadStateFromSession(
	ctx: ExtensionContext,
): PiettaState | null {
	const sessionState = getSessionStateEntry(ctx.sessionManager.getEntries())
	if (!sessionState?.currentAgentId) return null
	return {
		currentAgentId: sanitizeAgentId(sessionState.currentAgentId),
	}
}

export function saveStateToSession(pi: ExtensionAPI, state: PiettaState): void {
	pi.appendEntry<PiettaSessionState>(PIETTA_SESSION_STATE_TYPE, {
		currentAgentId: sanitizeAgentId(state.currentAgentId),
	})
}

export function getAgentIds(): string[] {
	const agentsDir = path.join(getStorageRoot(), "agents")
	if (!existsSync(agentsDir)) return []
	return readdirSync(agentsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
}
