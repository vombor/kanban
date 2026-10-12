import { useCallback, useMemo, useState } from "react";

import type { ProjectKitChoicesState } from "@/hooks/use-project-kit-choices";
import type { RuntimeAgentId } from "@/runtime/types";

/** A custom team's model for one role: an agent (none = the selected agent, or for the fallback the dev agent). */
export interface CustomTeamRole {
	agentId: RuntimeAgentId | "";
	provider: string;
	model: string;
}

export const CUSTOM_TEAM_ROLES = ["dev", "qa", "plan", "fallback"] as const;
export type CustomTeamRoleName = (typeof CUSTOM_TEAM_ROLES)[number];

/** The roles a custom team must name an agent for (src/kits/apply-kit.ts `describeCustomTeamGap`). */
const REQUIRED_CUSTOM_ROLES: readonly CustomTeamRoleName[] = ["dev", "qa"];

/** The preset choice that means "the project's own role models". */
export const CUSTOM_PRESET_VALUE = "custom";

const EMPTY_ROLE: CustomTeamRole = { agentId: "", provider: "", model: "" };

/** What the add/create request carries for the picked kit (src/core/api-contract.ts). */
export interface ProjectKitRequest {
	kit: string;
	preset?: string | null;
	roleSettings?: Record<string, string>;
}

export interface ProjectKitSelection {
	kitName: string;
	isTeamKit: boolean;
	/** A preset name or CUSTOM_PRESET_VALUE; only meaningful on the team kit. */
	presetValue: string;
	customRoles: Record<CustomTeamRoleName, CustomTeamRole>;
	setKitName: (kitName: string) => void;
	setPresetValue: (value: string) => void;
	setCustomRole: (role: CustomTeamRoleName, patch: Partial<CustomTeamRole>) => void;
	request: ProjectKitRequest;
	/** Why the project can't be added on this pick yet (a custom team without its dev or QA agent), or null. */
	blockedReason: string | null;
}

function createEmptyRoles(): Record<CustomTeamRoleName, CustomTeamRole> {
	return { dev: { ...EMPTY_ROLE }, qa: { ...EMPTY_ROLE }, plan: { ...EMPTY_ROLE }, fallback: { ...EMPTY_ROLE } };
}

/** A custom team's role rows as `roles.<role>.agent|provider|model` settings (empty fields left out). */
export function toCustomRoleSettings(roles: Record<CustomTeamRoleName, CustomTeamRole>): Record<string, string> {
	const settings: Record<string, string> = {};
	for (const role of CUSTOM_TEAM_ROLES) {
		const { agentId, provider, model } = roles[role];
		if (agentId) {
			settings[`roles.${role}.agent`] = agentId;
		}
		if (model.trim()) {
			settings[`roles.${role}.model`] = model.trim();
			if (provider.trim()) {
				settings[`roles.${role}.provider`] = provider.trim();
			}
		}
	}
	return settings;
}

/**
 * The add-project dialog's kit pick: a kit (`default` preselected) and, for the team kit, a preset (the first one
 * preselected) or a custom team with its own role models. Reset with `reset()` each time the dialog opens.
 */
export function useProjectKitSelection(choices: ProjectKitChoicesState): ProjectKitSelection & { reset: () => void } {
	const [selectedKitName, setSelectedKitName] = useState<string | null>(null);
	const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
	const [customRoles, setCustomRoles] = useState(createEmptyRoles);

	const kitName =
		selectedKitName && choices.kits.some((kit) => kit.name === selectedKitName)
			? selectedKitName
			: choices.defaultKitName;
	const isTeamKit = kitName === choices.teamKitName;
	const presetValue =
		selectedPreset === CUSTOM_PRESET_VALUE ||
		(selectedPreset !== null && choices.presets.some((preset) => preset.name === selectedPreset))
			? selectedPreset
			: (choices.presets[0]?.name ?? CUSTOM_PRESET_VALUE);

	const setCustomRole = useCallback((role: CustomTeamRoleName, patch: Partial<CustomTeamRole>) => {
		setCustomRoles((previous) => ({ ...previous, [role]: { ...previous[role], ...patch } }));
	}, []);

	const reset = useCallback(() => {
		setSelectedKitName(null);
		setSelectedPreset(null);
		setCustomRoles(createEmptyRoles());
	}, []);

	const { request, blockedReason } = useMemo((): Pick<ProjectKitSelection, "request" | "blockedReason"> => {
		if (!isTeamKit) {
			return { request: { kit: kitName }, blockedReason: null };
		}
		if (presetValue !== CUSTOM_PRESET_VALUE) {
			return { request: { kit: kitName, preset: presetValue }, blockedReason: null };
		}
		const missing = REQUIRED_CUSTOM_ROLES.filter((role) => !customRoles[role].agentId);
		return {
			request: { kit: kitName, preset: null, roleSettings: toCustomRoleSettings(customRoles) },
			blockedReason:
				missing.length > 0
					? `Pick the ${missing.join(" and ")} agent${missing.length > 1 ? "s" : ""} of the custom team.`
					: null,
		};
	}, [customRoles, isTeamKit, kitName, presetValue]);

	return {
		kitName,
		isTeamKit,
		presetValue,
		customRoles,
		setKitName: setSelectedKitName,
		setPresetValue: setSelectedPreset,
		setCustomRole,
		request,
		blockedReason,
		reset,
	};
}
