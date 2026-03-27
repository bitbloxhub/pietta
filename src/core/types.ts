export type Scope = "project" | "agent" | "session"
export type ReflectionTrigger = "off" | "compaction"
export type ReflectionStatus = "idle" | "success" | "skipped" | "error"
export type PiettaState = {
	currentAgentId: string
}
export type ReflectionConfig = {
	trigger: ReflectionTrigger
	lastReflectionKey?: string
	lastReflectionAt?: string
	lastReflectionStatus?: ReflectionStatus
	lastReflectionMessage?: string
	lastReflectionDebug?: string
}
export type MemoryPaths = {
	root: string
	stateFile: string
	agentsDir: string
	agentDir: string
	bareRepo: string
	workTree: string
	worktreesDir: string
	systemDir: string
	projectsDir: string
	projectDir: string
	projectSystemDir: string
	projectSummaryFile: string
	projectDecisionsFile: string
	timelineFile: string
	scratchpadFile: string
	sessionsDir: string
	sessionMemoryDir: string
	summariesDir: string
	latestSummaryFile: string
	archiveDir: string
	rulesDir: string
	projectRulesDir: string
	agentRulesDir: string
	generatedRulesDir: string
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
	path?: string
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
export const DEFAULT_REFLECTION_TRIGGER: ReflectionTrigger = "compaction"
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
export type SleeptimeArgs = {
	command: string
}
export type RememberArgs = {
	scope: Scope
	scopeExplicit: boolean
	path?: string
	text: string
}
export type MutationPathsResult = {
	paths: MemoryPaths
	worktreeKey: string
	source: string
}
