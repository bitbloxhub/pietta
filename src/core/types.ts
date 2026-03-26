import type { ExtensionContext } from "@mariozechner/pi-coding-agent"

export type Scope = "project" | "agent" | "session"

export type PiettaState = {
	currentAgentId: string
}

export type MemoryPaths = {
	root: string
	stateFile: string
	agentsDir: string
	agentDir: string
	bareRepo: string
	workTree: string
	worktreesDir: string
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

export type EnsureResult = {
	paths: MemoryPaths
	created: string[]
}

export type RememberInput = {
	text: string
	scope: Scope
	kind: string
	confidence: number
	source?: string
}

export type MemoryItem = {
	id: string
	filePath: string
	scope: Scope
	kind: string
	createdAt?: string
	updatedAt?: string
	sources: string[]
	body: string
}

export type GitResult = {
	stdout: string
	stderr: string
	code: number
	killed: boolean
}

export type SyncConflictStrategy = "ours" | "theirs"

export const EXTENSION_NAME = "pietta"
export const DEFAULT_AGENT_ID = "default"
export const SCOPE_VALUES = ["project", "agent", "session"] as const
export const WORKTREE_REGISTRATION_RETRIES = 5

export type AgentsArgs = {
	command: string
	value?: string
}

export type MemoryArgs = {
	command: string
	selector?: string
	text?: string
}

export type MutationPathsResult = {
	paths: MemoryPaths
	worktreeKey: string
	source: string
}

export type SessionWorktreeResolver = (ctx: ExtensionContext) => string
