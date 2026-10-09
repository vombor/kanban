// Persists Kanban-owned runtime preferences on disk (the global config.json in the Kanban home).
// This module should store Kanban settings such as selected agents and prompt templates, not SDK-owned Cline
// secrets or OAuth data. A project's shortcuts are not here: they are in the shortcut store
// (src/projects/project-shortcut-store.ts), which only the shortcut route writes.
import { readFile } from "node:fs/promises";
import { getRuntimeAgentCatalogEntry, isRuntimeAgentLaunchSupported } from "../core/agent-catalog";
import type { RuntimeAgentId } from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { getKanbanGlobalConfigPath, KANBAN_HOME_MARKER_VERSION } from "../state/kanban-home";
import { detectInstalledCommands } from "../terminal/agent-registry";

interface RuntimeGlobalConfigFileShape {
	/** Initialized-home marker, see kanban-home.ts. */
	home?: number;
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string;
	agentAutonomousModeEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
}

export interface RuntimeConfigState {
	globalConfigPath: string;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
	commitPromptTemplateDefault: string;
	openPrPromptTemplateDefault: string;
}

export interface RuntimeConfigUpdateInput {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string | null;
	agentAutonomousModeEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
}

// Keys this module rewrites. Every other key in the global config.json (home-resolver and team settings) is preserved.
const MANAGED_GLOBAL_CONFIG_KEYS: ReadonlySet<string> = new Set([
	"selectedAgentId",
	"selectedShortcutLabel",
	"agentAutonomousModeEnabled",
	"readyForReviewNotificationsEnabled",
	"commitPromptTemplate",
	"openPrPromptTemplate",
]);
const DEFAULT_AGENT_ID: RuntimeAgentId = "cline";
const AUTO_SELECT_AGENT_PRIORITY: readonly RuntimeAgentId[] = ["claude", "codex", "droid", "kiro"];
const DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED = true;
const DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED = true;
const DEFAULT_COMMIT_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, commit the working changes onto {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not edit files outside git workflows unless required for conflict resolution.
- Preserve any pre-existing user uncommitted changes in the base worktree.

Steps:
1. In the current task worktree, stage and create a commit for the pending task changes.
2. Find where {{base_ref}} is checked out:
   - Run: git worktree list --porcelain
   - If branch {{base_ref}} is checked out in path P, use that P.
   - If not checked out anywhere, use current worktree as P by checking out {{base_ref}} there.
3. In P, verify current branch is {{base_ref}}.
4. If P has uncommitted changes, stash them: git -C P stash push -u -m "kanban-pre-cherry-pick"
5. Cherry-pick the task commit into P. If this fails because .git/index.lock exists, wait briefly for any active git process to finish. If the lock remains and no git process is active, treat the lock as stale, remove it, and retry.
6. If cherry-pick conflicts, resolve carefully, preserving both the intended task changes and existing user edits.
7. If step 4 created a new stash entry, restore that stash with: git -C P stash pop <stash-ref>
8. If stash pop conflicts, resolve them while preserving pre-existing user edits.
9. Report:
   - Final commit hash
   - Final commit message
   - Whether stash was used
   - Whether conflicts were resolved
   - Any remaining manual follow-up needed`;
const DEFAULT_OPEN_PR_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, open a pull request against {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not modify the base worktree.
- Keep all PR preparation in the current task worktree.

Steps:
1. Ensure all intended changes are committed in the current task worktree.
2. If currently on detached HEAD, create a branch at the current commit in this worktree.
3. Push the branch to origin and set upstream.
4. Create a pull request with base {{base_ref}} and head as the pushed branch (use gh CLI if available).
5. If a pull request already exists for the same head and base, return that existing PR URL instead of creating a duplicate.
6. If PR creation is blocked, explain exactly why and provide the exact commands to complete it manually.
7. Report:
   - PR title: PR URL
   - Base branch
   - Head branch
   - Any follow-up needed`;

export function pickBestInstalledAgentIdFromDetected(detectedCommands: readonly string[]): RuntimeAgentId | null {
	const detected = new Set(detectedCommands);
	for (const agentId of AUTO_SELECT_AGENT_PRIORITY) {
		const catalogEntry = getRuntimeAgentCatalogEntry(agentId);
		const binary = catalogEntry?.binary ?? agentId;
		if (detected.has(binary) || detected.has(agentId)) {
			return agentId;
		}
	}
	return null;
}

function normalizeAgentId(rawAgentId: RuntimeAgentId | string | null | undefined): RuntimeAgentId {
	// "cline-cli" is the old id of the Cline CLI agent; it is now just "cline".
	const agentId = rawAgentId === "cline-cli" ? "cline" : rawAgentId;
	if (
		(agentId === "claude" ||
			agentId === "codex" ||
			agentId === "gemini" ||
			agentId === "opencode" ||
			agentId === "droid" ||
			agentId === "kiro" ||
			agentId === "copilot" ||
			agentId === "cline") &&
		isRuntimeAgentLaunchSupported(agentId)
	) {
		return agentId;
	}
	return DEFAULT_AGENT_ID;
}

function pickBestInstalledAgentId(): RuntimeAgentId | null {
	return pickBestInstalledAgentIdFromDetected(detectInstalledCommands());
}

function normalizePromptTemplate(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return fallback;
}

function normalizeShortcutLabel(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function hasOwnKey<T extends object>(value: T | null, key: keyof T): boolean {
	if (!value) {
		return false;
	}
	return Object.hasOwn(value, key);
}

export function getRuntimeGlobalConfigPath(): string {
	return getKanbanGlobalConfigPath();
}

function toRuntimeConfigState({
	globalConfigPath,
	globalConfig,
}: {
	globalConfigPath: string;
	globalConfig: RuntimeGlobalConfigFileShape | null;
}): RuntimeConfigState {
	return {
		globalConfigPath,
		selectedAgentId: normalizeAgentId(globalConfig?.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(globalConfig?.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			globalConfig?.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			globalConfig?.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		commitPromptTemplate: normalizePromptTemplate(globalConfig?.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(
			globalConfig?.openPrPromptTemplate,
			DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

async function readRuntimeConfigFile<T>(configPath: string): Promise<T | null> {
	try {
		const raw = await readFile(configPath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function writeRuntimeGlobalConfigFile(
	configPath: string,
	config: {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		agentAutonomousModeEnabled?: boolean;
		readyForReviewNotificationsEnabled?: boolean;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
	},
): Promise<void> {
	const existing = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(configPath);
	const selectedAgentId = config.selectedAgentId === undefined ? undefined : normalizeAgentId(config.selectedAgentId);
	const existingSelectedAgentId = hasOwnKey(existing, "selectedAgentId")
		? normalizeAgentId(existing?.selectedAgentId)
		: undefined;
	const selectedShortcutLabel =
		config.selectedShortcutLabel === undefined ? undefined : normalizeShortcutLabel(config.selectedShortcutLabel);
	const existingSelectedShortcutLabel = hasOwnKey(existing, "selectedShortcutLabel")
		? normalizeShortcutLabel(existing?.selectedShortcutLabel)
		: undefined;
	const agentAutonomousModeEnabled =
		config.agentAutonomousModeEnabled === undefined
			? DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED
			: normalizeBoolean(config.agentAutonomousModeEnabled, DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED);
	const readyForReviewNotificationsEnabled =
		config.readyForReviewNotificationsEnabled === undefined
			? DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
			: normalizeBoolean(config.readyForReviewNotificationsEnabled, DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED);
	const commitPromptTemplate =
		config.commitPromptTemplate === undefined
			? DEFAULT_COMMIT_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE);
	const openPrPromptTemplate =
		config.openPrPromptTemplate === undefined
			? DEFAULT_OPEN_PR_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE);

	const payload: RuntimeGlobalConfigFileShape & Record<string, unknown> = {};
	for (const [key, value] of Object.entries(existing ?? {})) {
		if (!MANAGED_GLOBAL_CONFIG_KEYS.has(key)) {
			payload[key] = value;
		}
	}
	payload.home = KANBAN_HOME_MARKER_VERSION;
	if (selectedAgentId !== undefined) {
		if (hasOwnKey(existing, "selectedAgentId") || selectedAgentId !== DEFAULT_AGENT_ID) {
			payload.selectedAgentId = selectedAgentId;
		}
	} else if (existingSelectedAgentId !== undefined) {
		payload.selectedAgentId = existingSelectedAgentId;
	}
	if (selectedShortcutLabel !== undefined) {
		if (selectedShortcutLabel) {
			payload.selectedShortcutLabel = selectedShortcutLabel;
		}
	} else if (existingSelectedShortcutLabel) {
		payload.selectedShortcutLabel = existingSelectedShortcutLabel;
	}
	if (
		hasOwnKey(existing, "agentAutonomousModeEnabled") ||
		agentAutonomousModeEnabled !== DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED
	) {
		payload.agentAutonomousModeEnabled = agentAutonomousModeEnabled;
	}
	if (
		hasOwnKey(existing, "readyForReviewNotificationsEnabled") ||
		readyForReviewNotificationsEnabled !== DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
	) {
		payload.readyForReviewNotificationsEnabled = readyForReviewNotificationsEnabled;
	}
	if (hasOwnKey(existing, "commitPromptTemplate") || commitPromptTemplate !== DEFAULT_COMMIT_PROMPT_TEMPLATE) {
		payload.commitPromptTemplate = commitPromptTemplate;
	}
	if (hasOwnKey(existing, "openPrPromptTemplate") || openPrPromptTemplate !== DEFAULT_OPEN_PR_PROMPT_TEMPLATE) {
		payload.openPrPromptTemplate = openPrPromptTemplate;
	}

	await lockedFileSystem.writeJsonFileAtomic(configPath, payload, {
		lock: null,
	});
}

function getRuntimeConfigLockRequests(globalConfigPath: string): LockRequest[] {
	return [{ path: globalConfigPath, type: "file" }];
}

async function loadRuntimeConfigLocked(globalConfigPath: string): Promise<RuntimeConfigState> {
	let globalConfig = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(globalConfigPath);
	if (globalConfig === null) {
		const autoSelectedAgentId = pickBestInstalledAgentId();
		if (autoSelectedAgentId) {
			await writeRuntimeGlobalConfigFile(globalConfigPath, {
				selectedAgentId: autoSelectedAgentId,
			});
			globalConfig = {
				selectedAgentId: autoSelectedAgentId,
			};
		}
	}
	return toRuntimeConfigState({ globalConfigPath, globalConfig });
}

function createRuntimeConfigStateFromValues(input: {
	globalConfigPath: string;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
}): RuntimeConfigState {
	return {
		globalConfigPath: input.globalConfigPath,
		selectedAgentId: normalizeAgentId(input.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(input.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			input.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			input.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		commitPromptTemplate: normalizePromptTemplate(input.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(input.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

export async function loadGlobalRuntimeConfig(): Promise<RuntimeConfigState> {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	const globalConfig = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(globalConfigPath);
	if (globalConfig !== null) {
		return toRuntimeConfigState({ globalConfigPath, globalConfig });
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(globalConfigPath),
		async () => await loadRuntimeConfigLocked(globalConfigPath),
	);
}

/**
 * The runtime config a project's board sees. Today that is the global config: the one per-project setting, the
 * shortcuts, is in the shortcut store (src/projects/project-shortcut-store.ts), never in the project's repo.
 */
export async function loadRuntimeConfig(_projectPath: string): Promise<RuntimeConfigState> {
	return await loadGlobalRuntimeConfig();
}

export async function saveRuntimeConfig(config: {
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
}): Promise<RuntimeConfigState> {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(globalConfigPath), async () => {
		await writeRuntimeGlobalConfigFile(globalConfigPath, config);
		return createRuntimeConfigStateFromValues({ globalConfigPath, ...config });
	});
}

function applyRuntimeConfigUpdates(current: RuntimeConfigState, updates: RuntimeConfigUpdateInput) {
	return {
		selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
		selectedShortcutLabel:
			updates.selectedShortcutLabel === undefined ? current.selectedShortcutLabel : updates.selectedShortcutLabel,
		agentAutonomousModeEnabled: updates.agentAutonomousModeEnabled ?? current.agentAutonomousModeEnabled,
		readyForReviewNotificationsEnabled:
			updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
		commitPromptTemplate: updates.commitPromptTemplate ?? current.commitPromptTemplate,
		openPrPromptTemplate: updates.openPrPromptTemplate ?? current.openPrPromptTemplate,
	};
}

async function writeRuntimeConfigUpdates(
	globalConfigPath: string,
	current: RuntimeConfigState,
	updates: RuntimeConfigUpdateInput,
): Promise<RuntimeConfigState> {
	const nextConfig = applyRuntimeConfigUpdates(current, updates);
	const hasChanges =
		nextConfig.selectedAgentId !== current.selectedAgentId ||
		nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
		nextConfig.agentAutonomousModeEnabled !== current.agentAutonomousModeEnabled ||
		nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
		nextConfig.commitPromptTemplate !== current.commitPromptTemplate ||
		nextConfig.openPrPromptTemplate !== current.openPrPromptTemplate;
	if (!hasChanges) {
		return current;
	}
	await writeRuntimeGlobalConfigFile(globalConfigPath, nextConfig);
	return createRuntimeConfigStateFromValues({ globalConfigPath, ...nextConfig });
}

/** Applies a settings save to the config on disk (read under the lock, so concurrent saves keep each other's keys). */
export async function updateRuntimeConfig(updates: RuntimeConfigUpdateInput): Promise<RuntimeConfigState> {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(globalConfigPath), async () => {
		const current = await loadRuntimeConfigLocked(globalConfigPath);
		return await writeRuntimeConfigUpdates(globalConfigPath, current, updates);
	});
}

/** Applies a settings save on top of `current` (the server's cached config). */
export async function updateGlobalRuntimeConfig(
	current: RuntimeConfigState,
	updates: RuntimeConfigUpdateInput,
): Promise<RuntimeConfigState> {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(globalConfigPath),
		async () => await writeRuntimeConfigUpdates(globalConfigPath, current, updates),
	);
}
