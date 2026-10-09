// The core settings a kit says its routing needs (`recommends.settings`), compared with what a project runs on.
// Pure: `kanban kit show` prints the result, `kanban doctor` warns about each unmet one. Nothing here writes
// config.json: like `recommends.landingMode`, a recommendation is only applied by the user.
import {
	getDefaultWorkspacePipelineSettings,
	getWorkspacePipelineSettings,
	type PipelineConfig,
} from "../config/pipeline-config";
import type { KitDocument, KitRecommendedSetting } from "./kit-schema";
import { readKitValue } from "./resolve-kit";

const WORKSPACE_KEY_PREFIX = "workspace.";

export interface KitRecommendedSettingStatus {
	setting: KitRecommendedSetting;
	/** The config.json key as the user writes it (`workspaces.<id>.…` for a `workspace.` key). */
	configKey: string;
	/** The value the project runs on (defaults included); undefined when the key is not a setting. */
	current: unknown;
	/** "unknown": no such setting in this build (a typo in the kit, or a setting that was removed). */
	status: "met" | "unmet" | "unknown";
}

function meets(setting: KitRecommendedSetting, current: unknown): boolean {
	switch (setting.op ?? "equals") {
		case "atMost":
			return typeof current === "number" && current <= (setting.value as number);
		case "atLeast":
			return typeof current === "number" && current >= (setting.value as number);
		default:
			return current === setting.value;
	}
}

export function describeRecommendedValue(setting: KitRecommendedSetting): string {
	const value = JSON.stringify(setting.value);
	switch (setting.op ?? "equals") {
		case "atMost":
			return `at most ${value}`;
		case "atLeast":
			return `at least ${value}`;
		default:
			return value;
	}
}

/**
 * Every `recommends.settings` entry of a resolved kit, read against the parsed config and one workspace (null: no
 * project, so `workspace.` keys read a new project's defaults).
 */
export function evaluateKitRecommendedSettings(
	kit: KitDocument,
	config: PipelineConfig,
	workspaceId: string | null,
): KitRecommendedSettingStatus[] {
	const workspace =
		workspaceId === null ? getDefaultWorkspacePipelineSettings() : getWorkspacePipelineSettings(config, workspaceId);
	return (kit.recommends?.settings ?? []).map((setting) => {
		const onWorkspace = setting.key.startsWith(WORKSPACE_KEY_PREFIX);
		const path = onWorkspace ? setting.key.slice(WORKSPACE_KEY_PREFIX.length) : setting.key;
		const current = readKitValue(onWorkspace ? workspace : config, path);
		return {
			setting,
			configKey: onWorkspace ? `workspaces.${workspaceId ?? "<id>"}.${path}` : setting.key,
			current,
			status: current === undefined ? "unknown" : meets(setting, current) ? "met" : "unmet",
		};
	});
}
