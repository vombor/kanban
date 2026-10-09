import type { RuntimeConfigState } from "../config/runtime-config";
import type { RuntimeAgentCapabilities, RuntimeAgentCatalogEntry } from "../core/agent-catalog";
import {
	getRuntimeLaunchSupportedAgentCatalog,
	isRuntimeAgentLaunchSupported,
	RUNTIME_AGENT_CATALOG,
} from "../core/agent-catalog";
import type {
	RuntimeAgentDefinition,
	RuntimeAgentId,
	RuntimeConfigResponse,
	RuntimeProjectShortcut,
} from "../core/api-contract";
import { getKanbanPathsSummary } from "../state/kanban-home";
import { isBinaryAvailableOnPath } from "./command-discovery";

export interface ResolvedAgentCommand {
	agentId: RuntimeAgentId;
	label: string;
	command: string;
	binary: string;
	args: string[];
}

function getDefaultArgs(agentId: RuntimeAgentId): string[] {
	const entry = RUNTIME_AGENT_CATALOG.find((candidate) => candidate.id === agentId);
	if (!entry) {
		return [];
	}
	return [...entry.baseArgs];
}

// An agent is installed when its binary is on PATH.
function isAgentInstalled(entry: RuntimeAgentCatalogEntry, detectedSet: ReadonlySet<string>): boolean {
	return detectedSet.has(entry.binary);
}

function quoteForDisplay(part: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part)) {
		return part;
	}
	return JSON.stringify(part);
}

function joinCommand(binary: string, args: string[]): string {
	if (args.length === 0) {
		return binary;
	}
	return [binary, ...args.map(quoteForDisplay)].join(" ");
}

function parseBooleanEnvValue(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isRuntimeDebugModeEnabled(): boolean {
	const debugModeValue = process.env.KANBAN_DEBUG_MODE ?? process.env.DEBUG_MODE ?? process.env.debug_mode;
	return parseBooleanEnvValue(debugModeValue);
}

export function detectInstalledCommands(): string[] {
	const candidates = [...RUNTIME_AGENT_CATALOG.map((entry) => entry.binary), "npx"];
	const detected: string[] = [];

	for (const candidate of candidates) {
		if (isBinaryAvailableOnPath(candidate)) {
			detected.push(candidate);
		}
	}

	return detected;
}

function getCuratedDefinitions(runtimeConfig: RuntimeConfigState, detected: string[]): RuntimeAgentDefinition[] {
	const detectedSet = new Set(detected);
	return getRuntimeLaunchSupportedAgentCatalog().map((entry) => {
		const defaultArgs = getDefaultArgs(entry.id);
		const command = joinCommand(entry.binary, defaultArgs);
		const isInstalled = isAgentInstalled(entry, detectedSet);
		return {
			id: entry.id,
			label: entry.label,
			binary: entry.binary,
			command,
			defaultArgs,
			installed: isInstalled,
			configured: runtimeConfig.selectedAgentId === entry.id,
		};
	});
}

export interface RuntimeAgentCapabilityReportEntry {
	id: RuntimeAgentId;
	label: string;
	installed: boolean;
	configured: boolean;
	launchSupported: boolean;
	capabilities: RuntimeAgentCapabilities;
}

// Mechanism-only report for the `kanban agents` command: no model/effort value lists.
export function buildAgentCapabilityReport(runtimeConfig: RuntimeConfigState): RuntimeAgentCapabilityReportEntry[] {
	const detectedSet = new Set(detectInstalledCommands());
	return RUNTIME_AGENT_CATALOG.map((entry) => ({
		id: entry.id,
		label: entry.label,
		installed: isAgentInstalled(entry, detectedSet),
		configured: runtimeConfig.selectedAgentId === entry.id,
		launchSupported: isRuntimeAgentLaunchSupported(entry.id),
		capabilities: entry.capabilities,
	}));
}

export function resolveAgentCommand(runtimeConfig: RuntimeConfigState): ResolvedAgentCommand | null {
	const selected = getRuntimeLaunchSupportedAgentCatalog().find((entry) => entry.id === runtimeConfig.selectedAgentId);
	if (!selected) {
		return null;
	}
	const defaultArgs = getDefaultArgs(selected.id);
	const command = joinCommand(selected.binary, defaultArgs);
	if (isBinaryAvailableOnPath(selected.binary)) {
		return {
			agentId: selected.id,
			label: selected.label,
			command,
			binary: selected.binary,
			args: defaultArgs,
		};
	}
	return null;
}

/** Server-wide settings read once at startup, not part of the per-workspace config state. */
export interface RuntimeConfigResponseServerSettings {
	sessionSyncEnabled: boolean;
}

/** The scoped project's own part of the response: its shortcuts and where they are stored. */
export interface RuntimeConfigResponseProject {
	shortcuts: RuntimeProjectShortcut[];
	shortcutsPath: string;
}

export function buildRuntimeConfigResponse(
	runtimeConfig: RuntimeConfigState,
	serverSettings: RuntimeConfigResponseServerSettings,
	project: RuntimeConfigResponseProject | null = null,
): RuntimeConfigResponse {
	const detectedCommands = detectInstalledCommands();
	const agents = getCuratedDefinitions(runtimeConfig, detectedCommands);
	const resolved = resolveAgentCommand(runtimeConfig);
	const effectiveCommand = resolved ? joinCommand(resolved.binary, resolved.args) : null;

	return {
		selectedAgentId: runtimeConfig.selectedAgentId,
		selectedShortcutLabel: runtimeConfig.selectedShortcutLabel,
		agentAutonomousModeEnabled: runtimeConfig.agentAutonomousModeEnabled,
		debugModeEnabled: isRuntimeDebugModeEnabled(),
		effectiveCommand,
		globalConfigPath: runtimeConfig.globalConfigPath,
		projectConfigPath: project?.shortcutsPath ?? null,
		kanbanPaths: getKanbanPathsSummary(),
		readyForReviewNotificationsEnabled: runtimeConfig.readyForReviewNotificationsEnabled,
		sessionSyncEnabled: serverSettings.sessionSyncEnabled,
		detectedCommands,
		agents,
		shortcuts: project?.shortcuts ?? [],
		commitPromptTemplate: runtimeConfig.commitPromptTemplate,
		openPrPromptTemplate: runtimeConfig.openPrPromptTemplate,
		commitPromptTemplateDefault: runtimeConfig.commitPromptTemplateDefault,
		openPrPromptTemplateDefault: runtimeConfig.openPrPromptTemplateDefault,
	};
}
