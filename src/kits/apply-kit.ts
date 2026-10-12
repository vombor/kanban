// `kanban kit apply`: points a workspace at a kit (`workspaces.<id>.kit.name`, and for the `team` kit its preset
// `kit.preset` or none for a custom team, whose dev and QA agents must then be set), keeps its existing project settings,
// edits them with `--set` (model settings and project facts only, src/kits/project-settings.ts) / `--unset` (any stored
// key, so a team key from before the split can be removed), logs those edits to the settings history, and with
// `--landing` also sets the core landing mode. Applying a kit never changes the landing mode on its own (§4.2). On a
// switch to another kit, a stored setting that doesn't fit the new kit (a role, tier or list entry it lacks, a tier it
// doesn't have) is dropped and reported (`dropped`); team keys stored before the split stay, as before. The new
// resolution is validated before anything is written, so an unknown override key or a tier without a usable model is
// refused here, not discovered by the pipeline.
//
// Who may run it is decided by the runtime route (src/trpc/kit-settings-api.ts: the user and the project's own
// orchestrator). The orchestrator switches its project's kit and edits its project settings; the landing mode and
// removing a stored team key stay the user's, so its `--landing` and such an `--unset` are refused here.
import {
	getWorkspacePipelineSettings,
	type LandingMode,
	readPipelineConfig,
	updateWorkspacePipelineEntry,
} from "../config/pipeline-config";
import { getKitSettingsHistoryPath } from "../state/kanban-home";
import { isLegacyKitKey, translateLegacyOverrides } from "./kit-legacy-keys";
import { evaluateKitRecommendedSettings, type KitRecommendedSettingStatus } from "./kit-recommendations";
import { resolveKitRole } from "./kit-roles";
import type { KitDocument } from "./kit-schema";
import {
	appendKitSettingsHistory,
	classifyKitSettingKey,
	diffOverridesForHistory,
	isProjectSettingClass,
	type KitSettingsActor,
} from "./project-settings";
import { formatKitSelection, formatKitSelectionArgs } from "./renamed-kits";
import {
	DEFAULT_KIT_NAME,
	type KitCatalog,
	loadKitCatalog,
	readKitValue,
	resolveKitByName,
	resolveWorkspaceKit,
	TEAM_KIT_NAME,
} from "./resolve-kit";

export interface ApplyKitInput {
	workspaceId: string;
	kitName: string;
	/**
	 * The team kit's preset; null = a custom team (the project's own role models). Undefined keeps the workspace's
	 * current preset when it is already on the kit; the team kit needs one or the other.
	 */
	preset?: string | null;
	landing?: LandingMode;
	set?: Record<string, unknown>;
	unset?: string[];
	dryRun?: boolean;
	configPath?: string;
	kitsDir?: string;
	historyPath?: string;
	/** Who applies it (the history's `by`); default a user-run command in-process. */
	by?: KitSettingsActor;
}

export interface KitValueChange {
	key: string;
	from: unknown;
	to: unknown;
	fromSource: string | null;
	toSource: string | null;
}

export interface ApplyKitResult {
	workspaceId: string;
	kitName: { from: string; to: string };
	preset: { from: string | null; to: string | null };
	landing: { from: LandingMode; to: LandingMode };
	overrides: Record<string, unknown>;
	changes: KitValueChange[];
	/** Stored settings the switch removed because they don't fit the new kit. */
	dropped: DroppedKitSetting[];
	recommendedLandingMode: LandingMode | null;
	/** The kit's `recommends.settings` the config doesn't meet yet (never applied here). */
	unmetSettings: KitRecommendedSettingStatus[];
	/** Issues with the workspace's current kit (it fell back to `default`). */
	previousIssues: string[];
	written: boolean;
}

export interface DroppedKitSetting {
	key: string;
	value: unknown;
	why: string;
}

/**
 * Why a stored setting doesn't fit `kitName` with `preset` (null: it does). Team keys from before the split fit wherever
 * they resolve.
 */
function findMisfit(
	catalog: KitCatalog,
	kitName: string,
	preset: string | null,
	key: string,
	value: unknown,
): string | null {
	const team = resolveKitByName(catalog, kitName, {}, preset);
	if (!team.ok) {
		return team.error;
	}
	for (const translated of Object.keys(translateLegacyOverrides({ [key]: value }).overrides)) {
		const classified = classifyKitSettingKey(translated, team.kit);
		if (classified.kind === "invalid") {
			return classified.message;
		}
	}
	const alone = resolveKitByName(catalog, kitName, { [key]: value }, preset);
	return alone.ok ? null : alone.error;
}

/** The preset `kit apply` uses: the given one, else the workspace's own when it stays on the kit. */
function choosePreset(input: ApplyKitInput, current: { name: string; preset: string | null } | null): string | null {
	if (input.preset !== undefined) {
		return input.preset;
	}
	if (current?.name === input.kitName) {
		return current.preset;
	}
	if (input.kitName === TEAM_KIT_NAME) {
		throw new Error(
			`Kit ${TEAM_KIT_NAME} needs its models: a preset (kanban kit apply ${TEAM_KIT_NAME} --preset <name>, see kanban kit presets) or a custom team (kanban kit apply ${TEAM_KIT_NAME} --custom --set roles.dev.agent=<agent> --set roles.qa.agent=<agent> ...).`,
		);
	}
	return null;
}

/**
 * A custom team (the team kit without a preset) must name its dev and QA agents: without a QA agent no card would be
 * QA'd (the policy answers "no roles.qa agent"), and without a dev agent every card would run on the selected agent.
 * Null when the kit isn't a custom team or names both.
 */
export function describeCustomTeamGap(kitName: string, preset: string | null, kit: KitDocument): string | null {
	if (kitName !== TEAM_KIT_NAME || preset !== null) {
		return null;
	}
	const missing = (["dev", "qa"] as const).filter((role) => !resolveKitRole(kit, role)?.agentId);
	if (missing.length === 0) {
		return null;
	}
	return `a custom team (${TEAM_KIT_NAME} without a preset) needs ${missing.map((role) => `roles.${role}.agent`).join(" and ")}: set ${missing.length === 1 ? "it" : "them"} with --set roles.<role>.agent=<agent> (and .provider/.model), or pick a preset (--preset <name>)`;
}

function isObject(value: unknown): boolean {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function applyWorkspaceKit(input: ApplyKitInput): Promise<ApplyKitResult> {
	const [{ config }, catalog] = await Promise.all([
		readPipelineConfig(input.configPath),
		loadKitCatalog(input.kitsDir),
	]);
	const settings = getWorkspacePipelineSettings(config, input.workspaceId);
	const before = resolveWorkspaceKit(config, input.workspaceId, catalog);
	const byOrchestrator = input.by?.kind === "orchestrator";
	if (byOrchestrator && input.landing) {
		throw new Error(
			`--landing ${input.landing}: the landing mode is the user's (kanban kit apply ${input.kitName} --project ${input.workspaceId} --landing ${input.landing}); the orchestrator switches the kit and its project settings only.`,
		);
	}
	const preset = choosePreset(input, settings.kit ? { name: settings.kit.name, preset: settings.kit.preset } : null);
	const selection = formatKitSelection({ name: input.kitName, preset });
	const team = resolveKitByName(catalog, input.kitName, {}, preset);
	if (!team.ok) {
		throw new Error(`Kit ${selection} does not resolve: ${team.error}`);
	}
	const overrides: Record<string, unknown> = { ...(settings.kit?.overrides ?? {}) };
	for (const key of input.unset ?? []) {
		if (!Object.hasOwn(overrides, key)) {
			throw new Error(`--unset ${key}: the workspace has no override for ${key}.`);
		}
		// A team key stored before the split (or a legacy key) changes the team when removed: the user's.
		if (byOrchestrator && (isLegacyKitKey(key) || !isProjectSettingClass(classifyKitSettingKey(key, team.kit)))) {
			throw new Error(
				`--unset ${key}: not a project setting of kit ${selection}; removing a stored team key is the user's (kanban kit migrate-overrides).`,
			);
		}
		delete overrides[key];
	}
	const dropped: DroppedKitSetting[] = [];
	if ((settings.kit?.name ?? DEFAULT_KIT_NAME) !== input.kitName || (settings.kit?.preset ?? null) !== preset) {
		for (const [key, value] of Object.entries(overrides)) {
			const why = findMisfit(catalog, input.kitName, preset, key, value);
			if (why !== null) {
				dropped.push({ key, value, why });
				delete overrides[key];
			}
		}
	}
	for (const key of Object.keys(input.set ?? {})) {
		const classified = classifyKitSettingKey(key, team.kit);
		if (!isProjectSettingClass(classified)) {
			throw new Error(`--set ${key}: ${classified.message}`);
		}
	}
	Object.assign(overrides, input.set ?? {});
	const after = resolveKitByName(catalog, input.kitName, overrides, preset);
	if (!after.ok) {
		throw new Error(`Kit ${selection} does not resolve for ${input.workspaceId}: ${after.error}`);
	}
	const customGap = describeCustomTeamGap(input.kitName, preset, after.kit);
	if (customGap) {
		throw new Error(`kanban kit apply ${formatKitSelectionArgs({ name: input.kitName, preset })}: ${customGap}.`);
	}
	const keys = new Set([...Object.keys(before.sources), ...Object.keys(after.sources)]);
	const changes: KitValueChange[] = [];
	for (const key of [...keys].sort()) {
		const from = readKitValue(before.kit, key);
		const to = readKitValue(after.kit, key);
		const fromSource = before.sources[key] ?? null;
		const toSource = after.sources[key] ?? null;
		// A key that is a leaf on one side only (`qa.rules: {}` vs `qa.rules.drive`): its leaves show the change.
		const interiorOnOneSide = (fromSource === null && isObject(from)) || (toSource === null && isObject(to));
		if (!interiorOnOneSide && (JSON.stringify(from) !== JSON.stringify(to) || fromSource !== toSource)) {
			changes.push({ key, from, to, fromSource, toSource });
		}
	}
	const landing = { from: settings.landing.mode, to: input.landing ?? settings.landing.mode };
	const result: ApplyKitResult = {
		workspaceId: input.workspaceId,
		kitName: { from: before.kitName, to: input.kitName },
		preset: { from: before.presetName, to: preset },
		landing,
		overrides,
		changes,
		dropped,
		recommendedLandingMode: after.kit.recommends?.landingMode ?? null,
		unmetSettings: evaluateKitRecommendedSettings(after.kit, config, input.workspaceId).filter(
			(status) => status.status !== "met",
		),
		previousIssues: before.issues,
		written: false,
	};
	if (input.dryRun) {
		return result;
	}
	await updateWorkspacePipelineEntry(
		input.workspaceId,
		(entry) => {
			const currentKit = entry.kit && typeof entry.kit === "object" ? (entry.kit as { overrides?: unknown }) : null;
			if (JSON.stringify(currentKit?.overrides ?? {}) !== JSON.stringify(settings.kit?.overrides ?? {})) {
				throw new Error(`workspaces.${input.workspaceId}.kit changed while applying; run the command again.`);
			}
			// No kit entry means `default`, so `default` without overrides is written as no entry.
			if (input.kitName === DEFAULT_KIT_NAME && Object.keys(overrides).length === 0) {
				delete entry.kit;
			} else if (input.kitName === TEAM_KIT_NAME) {
				entry.kit = { name: input.kitName, preset, overrides };
			} else {
				entry.kit = { name: input.kitName, overrides };
			}
			if (input.landing) {
				const current = entry.landing && typeof entry.landing === "object" ? entry.landing : {};
				entry.landing = { ...current, mode: input.landing };
			}
			return entry;
		},
		input.configPath,
	);
	const base = {
		at: new Date().toISOString(),
		workspaceId: input.workspaceId,
		kitName: input.kitName,
		by: input.by ?? { kind: "user-command" as const },
		via: "kit apply" as const,
	};
	const history = diffOverridesForHistory(settings.kit?.overrides ?? {}, overrides, base);
	if (before.presetName !== preset) {
		history.unshift({ ...base, key: "(preset)", from: before.presetName, to: preset });
	}
	if (before.kitName !== input.kitName) {
		history.unshift({ ...base, key: "(kit)", from: before.kitName, to: input.kitName });
	}
	await appendKitSettingsHistory(history, input.historyPath ?? getKitSettingsHistoryPath(input.workspaceId));
	return { ...result, written: true };
}
