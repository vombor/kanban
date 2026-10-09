// `kanban kit migrate-overrides` (the user's command, USER_ONLY_COMMANDS): turns a workspace's overrides from before
// the team/project split into project settings (src/kits/project-settings.ts) without changing what the project
// runs on:
//   - legacy model keys become their `roles.*` keys (`dev.agent` → `roles.dev.agent`);
//   - role models and facts stay project settings;
//   - team keys the kit already has with the same value are dropped (foo's `escalate.requireApproval: false` once
//     team.json's fallback needs no approval);
//   - the other team keys go into a new user kit (`$KANBAN_HOME/kits/<into>.json`: the project's kit with them
//     applied), and the workspace is switched to it.
// The plan is refused unless the new kit + project settings resolve to exactly the kit the workspace resolves to now
// (name and description aside), so a migration never changes routing.
import { isDeepStrictEqual } from "node:util";

import {
	getWorkspacePipelineSettings,
	readPipelineConfig,
	updateWorkspacePipelineEntry,
} from "../config/pipeline-config";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getKanbanKitsPath, getKitSettingsHistoryPath } from "../state/kanban-home";
import { translateLegacyOverrides } from "./kit-legacy-keys";
import { type KitDocument, kitNameSchema } from "./kit-schema";
import { appendKitSettingsHistory, classifyStoredOverrides, diffOverridesForHistory } from "./project-settings";
import {
	BUILT_IN_KIT_NAMES,
	DEFAULT_KIT_NAME,
	type KitCatalog,
	loadKitCatalog,
	parseUserKit,
	readKitValue,
	resolveKitByName,
} from "./resolve-kit";

export type OverrideMigrationTarget =
	| { kind: "project"; key: string }
	| { kind: "dropped"; why: string }
	| { kind: "user-kit"; kitName: string; key: string };

export interface OverrideMigrationRow {
	/** The stored key. */
	from: string;
	value: unknown;
	/** Where each part of it goes (a legacy key can split: `escalate.to` → roles.fallback.* and fallback.on.*). */
	to: OverrideMigrationTarget[];
}

export interface OverrideMigrationPlan {
	workspaceId: string;
	fromKit: string;
	toKit: string;
	rows: OverrideMigrationRow[];
	projectSettings: Record<string, unknown>;
	/** The new user kit, or null when every team key was redundant. */
	userKit: KitDocument | null;
	userKitPath: string | null;
	/** Nothing to do: the overrides are project settings already. */
	unchanged: boolean;
}

function sortedKeys(record: Record<string, unknown>): string[] {
	return Object.keys(record).sort();
}

/** A resolved kit without what only names it, for the "same routing" check. */
function routingOf(kit: KitDocument): Record<string, unknown> {
	const { name: _name, description: _description, ...rest } = kit;
	return rest;
}

export function planOverrideMigration(input: {
	workspaceId: string;
	catalog: KitCatalog;
	kitName: string;
	overrides: Record<string, unknown>;
	into?: string;
	kitsDir?: string;
}): OverrideMigrationPlan {
	const { catalog, kitName, overrides, workspaceId } = input;
	const team = resolveKitByName(catalog, kitName);
	if (!team.ok) {
		throw new Error(`kit ${kitName} does not resolve: ${team.error}`);
	}
	const current = resolveKitByName(catalog, kitName, overrides);
	if (!current.ok) {
		throw new Error(`${workspaceId}'s overrides don't resolve on kit ${kitName}: ${current.error}`);
	}
	const classified = classifyStoredOverrides(overrides, team.kit);
	if (classified.invalid.length > 0) {
		throw new Error(
			`${workspaceId} has overrides that are neither project settings nor team keys: ${classified.invalid.map((issue) => `${issue.key} (${issue.message})`).join("; ")}`,
		);
	}
	// Team keys the kit (with the project settings) already resolves to the same value are redundant.
	const withProject = resolveKitByName(catalog, kitName, classified.project);
	if (!withProject.ok) {
		throw new Error(`${workspaceId}'s project settings alone don't resolve on kit ${kitName}: ${withProject.error}`);
	}
	const kept: Record<string, unknown> = {};
	const redundant = new Set<string>();
	for (const [key, value] of Object.entries(classified.team)) {
		if (isDeepStrictEqual(readKitValue(withProject.kit, key), value)) {
			redundant.add(key);
		} else {
			kept[key] = value;
		}
	}
	const intoName = input.into ?? `${workspaceId}-team`;
	const needsKit = Object.keys(kept).length > 0;
	let userKit: KitDocument | null = null;
	let toKit = kitName;
	if (needsKit) {
		const nameCheck = kitNameSchema.safeParse(intoName);
		if (!nameCheck.success || BUILT_IN_KIT_NAMES.includes(intoName)) {
			throw new Error(`--into ${intoName}: not a user kit name (lowercase letters, digits, '-', '_'; not built-in)`);
		}
		if (catalog.kits.has(intoName)) {
			throw new Error(`kit ${intoName} already exists; pick another name with --into`);
		}
		const { description: keptDescription, ...keptTeam } = kept;
		const merged = resolveKitByName(catalog, kitName, keptTeam);
		if (!merged.ok) {
			throw new Error(`kit ${kitName} with ${workspaceId}'s team keys does not resolve: ${merged.error}`);
		}
		userKit = {
			...merged.kit,
			name: intoName,
			description:
				typeof keptDescription === "string"
					? keptDescription
					: `${kitName} with ${workspaceId}'s team changes (made by kanban kit migrate-overrides)`,
		};
		const parsed = parseUserKit(userKit, intoName);
		if (!parsed.ok) {
			throw new Error(`the new kit ${intoName} is invalid: ${parsed.error}`);
		}
		toKit = intoName;
	}
	const nextCatalog: KitCatalog = userKit
		? {
				kits: new Map([
					...catalog.kits,
					[intoName, { kit: userKit, origin: { kind: "user", path: `${getKanbanKitsPath()}/${intoName}.json` } }],
				]),
				errors: catalog.errors,
			}
		: catalog;
	const after = resolveKitByName(nextCatalog, toKit, classified.project);
	if (!after.ok || !isDeepStrictEqual(routingOf(after.kit), routingOf(current.kit))) {
		throw new Error(
			`the migration would change ${workspaceId}'s routing${after.ok ? "" : ` (${after.error})`}; nothing written. Report this as a Kanban bug.`,
		);
	}
	const translated = translateLegacyOverrides(overrides);
	const renamedFrom = new Map(translated.renamed.map(({ from, to }) => [from, to]));
	const targetOf = (key: string): OverrideMigrationTarget => {
		if (Object.hasOwn(classified.project, key)) {
			return { kind: "project", key };
		}
		if (redundant.has(key)) {
			return { kind: "dropped", why: `kit ${kitName} already has this value` };
		}
		return { kind: "user-kit", kitName: intoName, key };
	};
	const rows = sortedKeys(overrides).map((from) => ({
		from,
		value: overrides[from],
		to: (renamedFrom.get(from) ?? [from]).map(targetOf),
	}));
	const unchanged = !needsKit && redundant.size === 0 && isDeepStrictEqual(classified.project, overrides);
	return {
		workspaceId,
		fromKit: kitName,
		toKit,
		rows,
		projectSettings: classified.project,
		userKit,
		userKitPath: userKit ? `${input.kitsDir ?? getKanbanKitsPath()}/${intoName}.json` : null,
		unchanged,
	};
}

export async function migrateWorkspaceOverrides(input: {
	workspaceId: string;
	into?: string;
	dryRun?: boolean;
	configPath?: string;
	kitsDir?: string;
	historyPath?: string;
	now?: () => Date;
}): Promise<OverrideMigrationPlan & { written: boolean }> {
	const [{ config }, catalog] = await Promise.all([
		readPipelineConfig(input.configPath),
		loadKitCatalog(input.kitsDir),
	]);
	const settings = getWorkspacePipelineSettings(config, input.workspaceId);
	const kitName = settings.kit?.name ?? DEFAULT_KIT_NAME;
	const overrides = settings.kit?.overrides ?? {};
	const plan = planOverrideMigration({
		workspaceId: input.workspaceId,
		catalog,
		kitName,
		overrides,
		into: input.into,
		kitsDir: input.kitsDir,
	});
	if (input.dryRun || plan.unchanged) {
		return { ...plan, written: false };
	}
	if (plan.userKit && plan.userKitPath) {
		await lockedFileSystem.writeTextFileAtomic(plan.userKitPath, `${JSON.stringify(plan.userKit, null, "\t")}\n`);
	}
	const at = (input.now?.() ?? new Date()).toISOString();
	await updateWorkspacePipelineEntry(
		input.workspaceId,
		(entry) => {
			const currentKit = entry.kit && typeof entry.kit === "object" ? (entry.kit as Record<string, unknown>) : {};
			if (!isDeepStrictEqual(currentKit.overrides ?? {}, overrides)) {
				throw new Error(`workspaces.${input.workspaceId}.kit changed while migrating; run the command again.`);
			}
			entry.kit = { name: plan.toKit, overrides: plan.projectSettings };
			return entry;
		},
		input.configPath,
	);
	const base = {
		at,
		workspaceId: input.workspaceId,
		kitName: plan.toKit,
		by: { kind: "user-command" as const },
		via: "kit migrate-overrides" as const,
	};
	const history = diffOverridesForHistory(overrides, plan.projectSettings, base);
	if (plan.toKit !== plan.fromKit) {
		history.unshift({ ...base, key: "(kit)", from: plan.fromKit, to: plan.toKit });
	}
	await appendKitSettingsHistory(history, input.historyPath ?? getKitSettingsHistoryPath(input.workspaceId));
	return { ...plan, written: true };
}
