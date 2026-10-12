// The kits a new project can start on (user request 2026-10-12: "ask which routing kit it uses, defaulting to
// default"): every path that creates or first adds a project (the browser's add-project dialog, `kanban project
// create|add`) offers these, `default` first and preselected, each with its description and its four role models
// from the resolved kit, so user kits show the same way. The `team` kit comes with its presets (each with its four
// role models) and a custom team (the project's own role models, dev and QA agents required). The choice is applied
// through `kanban kit apply`'s code (apply-kit.ts, via src/projects/project-add.ts); this module only lists and
// checks names.
import type { RuntimeAgentId } from "../core/api-contract";
import { describeCustomTeamGap } from "./apply-kit";
import { resolveKitRole } from "./kit-roles";
import { KIT_ROLE_NAMES, type KitDocument, type KitRoleName } from "./kit-schema";
import { classifyKitSettingKey } from "./project-settings";
import { formatKitSelection, formatKitSelectionArgs, type KitSelection } from "./renamed-kits";
import {
	BUILT_IN_KIT_NAMES,
	BUILT_IN_PRESET_NAMES,
	DEFAULT_KIT_NAME,
	type KitCatalog,
	resolveKitByName,
	TEAM_KIT_NAME,
} from "./resolve-kit";

export interface KitChoiceRole {
	role: KitRoleName;
	/** False: the kit has no such role (dev/plan run on the selected agent, no QA reviewer, no fallback). */
	defined: boolean;
	/** None: the agent selected in Kanban settings (the fallback: the dev role's agent). */
	agentId: RuntimeAgentId | null;
	provider: string | null;
	/** None: the agent's own default model. */
	model: string | null;
	tier: string | null;
}

export interface KitChoice {
	name: string;
	description: string | null;
	origin: "built-in" | "user";
	/** Always the four roles, in schema order. */
	roles: KitChoiceRole[];
}

/** A preset of the `team` kit: its models, as the team kit with the preset resolves them. */
export interface KitPresetChoice {
	name: string;
	description: string | null;
	/** Always the four roles, in schema order. */
	roles: KitChoiceRole[];
}

export interface KitChoiceList {
	defaultKitName: string;
	/** The kit whose models come from `presets` or a custom team. */
	teamKitName: string;
	kits: KitChoice[];
	presets: KitPresetChoice[];
	/** User kits that can't be offered (refused files, or a kit that doesn't resolve). */
	errors: Array<{ name: string; error: string }>;
}

function listChoiceRoles(kit: KitDocument): KitChoiceRole[] {
	return KIT_ROLE_NAMES.map((role) => {
		const assignment = resolveKitRole(kit, role);
		return {
			role,
			defined: assignment !== null,
			agentId: assignment?.agentId ?? null,
			provider: assignment?.model?.provider ?? null,
			model: assignment?.model?.model ?? null,
			tier: assignment?.tier ?? null,
		};
	});
}

function orderByList(list: readonly string[]): (left: string, right: string) => number {
	return (left, right) => {
		const leftIndex = list.indexOf(left);
		const rightIndex = list.indexOf(right);
		if (leftIndex !== -1 || rightIndex !== -1) {
			return (
				(leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
				(rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
			);
		}
		return left.localeCompare(right);
	};
}

/**
 * The kits a new project may pick: `default`, the other built-in kits in their order, then user kits by name; and the
 * team kit's presets in their order.
 */
export function listKitChoices(catalog: KitCatalog): KitChoiceList {
	const kits: KitChoice[] = [];
	const errors: KitChoiceList["errors"] = catalog.errors.map((entry) => ({ name: entry.path, error: entry.error }));
	for (const name of [...catalog.kits.keys()].sort(orderByList(BUILT_IN_KIT_NAMES))) {
		const entry = catalog.kits.get(name);
		const resolved = resolveKitByName(catalog, name);
		if (!entry || !resolved.ok) {
			errors.push({ name, error: resolved.ok ? "missing" : resolved.error });
			continue;
		}
		kits.push({
			name,
			description: resolved.kit.description ?? null,
			origin: entry.origin.kind,
			roles: listChoiceRoles(resolved.kit),
		});
	}
	const presets: KitPresetChoice[] = [];
	for (const name of [...catalog.presets.keys()].sort(orderByList(BUILT_IN_PRESET_NAMES))) {
		const resolved = resolveKitByName(catalog, TEAM_KIT_NAME, {}, name);
		if (!resolved.ok) {
			errors.push({ name: `${TEAM_KIT_NAME} (${name})`, error: resolved.error });
			continue;
		}
		presets.push({
			name,
			description: catalog.presets.get(name)?.description ?? null,
			roles: listChoiceRoles(resolved.kit),
		});
	}
	return { defaultKitName: DEFAULT_KIT_NAME, teamKitName: TEAM_KIT_NAME, kits, presets, errors };
}

/** A new project's kit as picked: the kit, the team kit's preset (null: none) and a custom team's role settings. */
export interface NewProjectKitSelection extends KitSelection {
	/** `roles.<role>.agent|provider|model` of a custom team; empty otherwise. */
	roleSettings: Record<string, unknown>;
}

/**
 * The kit a new project starts on: `default` when none is named, else the named kit if it resolves. The `team` kit
 * needs a preset or, for a custom team (`preset: null`), role settings naming at least the dev and QA agents; role
 * settings are only for a custom team and only `roles.<role>.agent|provider|model`. Throws with the reason (unknown,
 * renamed, invalid) so a caller can refuse before it creates or registers anything.
 */
export function resolveNewProjectKit(
	catalog: KitCatalog,
	input: { kit?: string; preset?: string | null; roleSettings?: Record<string, unknown> },
): NewProjectKitSelection {
	const kitName = input.kit?.trim() || DEFAULT_KIT_NAME;
	const roleSettings = input.roleSettings ?? {};
	const preset = input.preset === undefined ? undefined : input.preset?.trim() || null;
	if (kitName === TEAM_KIT_NAME && preset === undefined) {
		throw new Error(
			`Kit ${TEAM_KIT_NAME} needs its models: a preset (${[...catalog.presets.keys()].join(", ")}) or a custom team with its own dev and QA agents.`,
		);
	}
	const selection = { name: kitName, preset: preset ?? null };
	const label = formatKitSelection(selection);
	if (Object.keys(roleSettings).length > 0 && !(kitName === TEAM_KIT_NAME && selection.preset === null)) {
		throw new Error(`Kit ${label}: role settings are only for a custom team (${TEAM_KIT_NAME} without a preset).`);
	}
	const team = resolveKitByName(catalog, kitName, {}, selection.preset);
	if (!team.ok) {
		throw new Error(`Kit ${label} can't be used: ${team.error}.`);
	}
	for (const key of Object.keys(roleSettings)) {
		const classified = classifyKitSettingKey(key, team.kit);
		if (classified.kind !== "role" || classified.field === "tier") {
			throw new Error(
				`Kit ${label}: ${key} is not a role setting (roles.<role>.agent|provider|model)${classified.kind === "invalid" || classified.kind === "team" ? `: ${classified.message}` : ""}.`,
			);
		}
	}
	const resolved = resolveKitByName(catalog, kitName, roleSettings, selection.preset);
	if (!resolved.ok) {
		throw new Error(`Kit ${label} can't be used: ${resolved.error}.`);
	}
	const gap = describeCustomTeamGap(kitName, selection.preset, resolved.kit);
	if (gap) {
		throw new Error(`Kit ${formatKitSelectionArgs(selection)}: ${gap}.`);
	}
	return { ...selection, roleSettings };
}
