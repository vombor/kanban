// A project's settings on top of its kit (docs/team/KITS.md "Project settings"). The kit is the team definition
// (kit-schema.ts); a project only sets
//   - the model of any role its kit defines: `roles.<role>.agent|provider|model|tier` (an unknown role, or one the kit
//     doesn't define, is an error),
//   - every other model its kit names (PROJECT_MODEL_KEYS): a tier's model picks (`tiers.<tier>`, or one entry's
//     provider/model/default), a QA route's reviewer, a plan candidate, a runoff racer, each only where the kit has
//     that tier or list entry (a project changes the kit's entries, it never adds any), and
//   - project facts: PROJECT_FACT_KEYS (the QA blurb, QA prompt notes, the QA servers script and preview, post-land
//     commands, plan prompt rules, the scripted checks' environment, the ignored paths task worktrees link).
// Every other key (onFail, fallback triggers and approval, qa.enabled/rules, a route's devModel, requireDifferentVendor,
// features, which tiers exist, ...) is the team: a project changes it only by using another kit (`kanban kit apply`,
// which the user and the project's own orchestrator may run; src/kits/apply-kit.ts).
//
// Stored as `workspaces.<id>.kit.overrides` in config.json: the resolver's existing input (kit < project settings),
// outside the project repo (a card can edit and land repo files), written under the config lock, moved by
// `kanban project rename-id` with the rest of `workspaces.<id>`. Every change is appended to
// `<home>/data/<ws>/kit-settings-history.jsonl`. Who may change them is decided by the runtime route
// (src/trpc/kit-settings-api.ts: the user and that project's orchestrator, never a card); this module only checks
// what may be changed.
//
// Overrides written before the split may hold legacy keys (kit-legacy-keys.ts) and team keys: they keep applying (the
// resolver reads them), doctor warns, and the user-run `kanban kit migrate-overrides` moves them
// (src/kits/migrate-overrides.ts).
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
	getWorkspacePipelineSettings,
	readPipelineConfig,
	updateWorkspacePipelineEntry,
} from "../config/pipeline-config";
import { getKitSettingsHistoryPath } from "../state/kanban-home";
import { isLegacyKitKey, translateLegacyOverrides } from "./kit-legacy-keys";
import {
	KIT_ROLE_MODEL_FIELDS,
	KIT_ROLE_NAMES,
	type KitDocument,
	type KitRoleName,
	kitDocumentObjectSchema,
} from "./kit-schema";
import { formatKitSelection, getRenamedKit } from "./renamed-kits";
import {
	DEFAULT_KIT_NAME,
	type KitCatalog,
	loadKitCatalog,
	readKitValue,
	resolveKitByName,
	TEAM_KIT_NAME,
} from "./resolve-kit";

/** Project facts a project sets on its kit: a key here, or anything under it. */
export const PROJECT_FACT_KEYS = [
	"qa.blurb",
	"qa.promptNotes",
	"qa.serversScript",
	"qa.preview",
	"land.postLand",
	"plan.rules",
	"checks",
	"worktrees.symlinkIgnored",
] as const;

/** The model fields of a kit's lists a project sets: `<list>.<index>.<field>` for an entry the kit has. */
const LIST_MODEL_FIELDS: ReadonlyArray<{ list: string; fields: readonly string[] }> = [
	{ list: "qa.routes", fields: ["agent", "provider", "model"] },
	{ list: "plan.candidates", fields: ["agent", "model", "model.provider", "model.model", "model.tier"] },
	{ list: "onFail.runoff.models", fields: ["agent", "provider", "model"] },
];

/** The fields of one tier entry a project sets (`tiers.<tier>.<index>.<field>`). */
const TIER_ENTRY_MODEL_FIELDS = ["provider", "model", "default"] as const;

/**
 * Every model setting besides the roles, as the key forms `kit set` takes (for messages, the sidebar prompt and the
 * docs). `<tier>` is a tier the kit defines and `<i>` an index of an entry the kit's list has.
 */
export const PROJECT_MODEL_KEYS = [
	"tiers.<tier>",
	`tiers.<tier>.<i>.${TIER_ENTRY_MODEL_FIELDS.join("|")}`,
	...LIST_MODEL_FIELDS.map(({ list, fields }) => `${list}.<i>.${fields.join("|")}`),
] as const;

export type KitSettingKeyClass =
	| { kind: "role"; role: KitRoleName; field: (typeof KIT_ROLE_MODEL_FIELDS)[number] }
	/** A model the kit names outside its roles (PROJECT_MODEL_KEYS). */
	| { kind: "model" }
	| { kind: "fact" }
	/** Part of the team definition: refused for a project. */
	| { kind: "team"; message: string }
	| { kind: "invalid"; message: string };

function isUnder(key: string, prefix: string): boolean {
	return key === prefix || key.startsWith(`${prefix}.`);
}

function teamKeyMessage(key: string, kitName: string): string {
	return `${key} is part of the team definition (kit ${kitName}), which a project can't change. A project sets only the models its kit names (roles.<role>.agent|provider|model|tier, ${PROJECT_MODEL_KEYS.join(", ")}) and project facts (${PROJECT_FACT_KEYS.join(", ")}). For another team, use another kit that has it (kanban kit apply <kit>; kits are made and edited only by the user).`;
}

function describeListLength(length: number): string {
	return length === 0 ? "no entries" : `entries 0-${length - 1}`;
}

/** `tiers.<tier>[.<i>[.<field>]]`: a tier's model picks, for a tier the kit defines. */
function classifyTierKey(key: string, segments: string[], kit: KitDocument): KitSettingKeyClass {
	const [, tier, index, ...field] = segments;
	if (tier === undefined) {
		return { kind: "team", message: teamKeyMessage(key, kit.name) };
	}
	const entries = kit.tiers?.[tier];
	if (!entries) {
		return {
			kind: "invalid",
			message: `kit ${kit.name} has no tier "${tier}"; a project sets only the tiers its kit defines (${Object.keys(kit.tiers ?? {}).join(", ") || "none"})`,
		};
	}
	if (index === undefined) {
		return { kind: "model" };
	}
	if (!/^\d+$/u.test(index) || Number(index) >= entries.length) {
		return {
			kind: "invalid",
			message: `kit ${kit.name}'s tiers.${tier} has no entry ${index} (${describeListLength(entries.length)}); set the whole list with tiers.${tier}`,
		};
	}
	if (
		field.length === 0 ||
		(field.length === 1 && (TIER_ENTRY_MODEL_FIELDS as readonly string[]).includes(field[0] ?? ""))
	) {
		return { kind: "model" };
	}
	return { kind: "team", message: teamKeyMessage(key, kit.name) };
}

/** `<list>.<i>.<field>` of LIST_MODEL_FIELDS; null when `key` is in none of those lists. */
function classifyListModelKey(key: string, kit: KitDocument): KitSettingKeyClass | null {
	for (const { list, fields } of LIST_MODEL_FIELDS) {
		if (!key.startsWith(`${list}.`)) {
			continue;
		}
		const [index = "", ...field] = key.slice(list.length + 1).split(".");
		const entries = readKitValue(kit, list);
		const length = Array.isArray(entries) ? entries.length : 0;
		if (!/^\d+$/u.test(index) || Number(index) >= length) {
			return {
				kind: "invalid",
				message: `kit ${kit.name}'s ${list} has no entry ${index} (${describeListLength(length)}); a project changes the models of the kit's entries, it never adds one`,
			};
		}
		return fields.includes(field.join(".")) ? { kind: "model" } : null;
	}
	return null;
}

/**
 * Whether `key` is a project setting of a project on `kit` (the kit as it resolves without the project's settings).
 */
export function classifyKitSettingKey(key: string, kit: KitDocument): KitSettingKeyClass {
	const segments = key.split(".");
	if (segments.some((segment) => segment.length === 0)) {
		return { kind: "invalid", message: `"${key}" has an empty segment` };
	}
	const [top] = segments as [string, ...string[]];
	if (top === "preset") {
		return {
			kind: "invalid",
			message: `${key} identifies the kit; another preset is kanban kit apply team --preset <name> (or --custom)`,
		};
	}
	if (!Object.hasOwn(kitDocumentObjectSchema.shape, top)) {
		return { kind: "invalid", message: `"${key}" is not a kit key` };
	}
	if (top === "kit" || top === "name") {
		return { kind: "invalid", message: `${key} identifies the kit; another kit is kanban kit apply <kit>` };
	}
	if (isLegacyKitKey(key)) {
		const renamed = translateLegacyOverrides({ [key]: null }).renamed[0]?.to ?? [];
		return {
			kind: "invalid",
			message: `${key} is a legacy key${renamed.length > 0 ? `; use ${renamed.join(", ")}` : ""}`,
		};
	}
	if (top === "roles") {
		const [, role, field, ...rest] = segments;
		if (!role || !field || rest.length > 0) {
			return {
				kind: "invalid",
				message: `set one field of a role: roles.<role>.${KIT_ROLE_MODEL_FIELDS.join("|")}`,
			};
		}
		if (!(KIT_ROLE_NAMES as readonly string[]).includes(role)) {
			return { kind: "invalid", message: `unknown role "${role}" (roles: ${KIT_ROLE_NAMES.join(", ")})` };
		}
		if (!kit.roles?.[role as KitRoleName]) {
			return {
				kind: "invalid",
				message: `kit ${kit.name} defines no ${role} role; a project can only set the roles its kit defines (${Object.keys(kit.roles ?? {}).join(", ") || "none"})`,
			};
		}
		if (!(KIT_ROLE_MODEL_FIELDS as readonly string[]).includes(field)) {
			return {
				kind: field === "note" ? "team" : "invalid",
				message:
					field === "note"
						? teamKeyMessage(key, kit.name)
						: `roles.${role}.${field} is not a role field (${KIT_ROLE_MODEL_FIELDS.join(", ")})`,
			};
		}
		return { kind: "role", role: role as KitRoleName, field: field as (typeof KIT_ROLE_MODEL_FIELDS)[number] };
	}
	if (top === "tiers") {
		return classifyTierKey(key, segments, kit);
	}
	const listModel = classifyListModelKey(key, kit);
	if (listModel) {
		return listModel;
	}
	if (PROJECT_FACT_KEYS.some((fact) => isUnder(key, fact))) {
		return { kind: "fact" };
	}
	return { kind: "team", message: teamKeyMessage(key, kit.name) };
}

/** A role model, another model the kit names, or a project fact. */
export function isProjectSettingClass(
	classified: KitSettingKeyClass,
): classified is Extract<KitSettingKeyClass, { kind: "role" | "model" | "fact" }> {
	return classified.kind === "role" || classified.kind === "model" || classified.kind === "fact";
}

/** A stored override set split by what it is, after translating its legacy keys. */
export interface ClassifiedOverrides {
	/** Models the kit names and facts (translated keys). */
	project: Record<string, unknown>;
	/** Team keys a project may no longer set (translated keys); they still apply until moved. */
	team: Record<string, unknown>;
	/** Keys that don't resolve to anything a project or kit can set. */
	invalid: Array<{ key: string; message: string }>;
	/** Legacy stored keys and what they mean now. */
	legacy: Array<{ from: string; to: string[] }>;
}

export function classifyStoredOverrides(overrides: Record<string, unknown>, kit: KitDocument): ClassifiedOverrides {
	const translated = translateLegacyOverrides(overrides);
	const result: ClassifiedOverrides = { project: {}, team: {}, invalid: [], legacy: translated.renamed };
	for (const [key, value] of Object.entries(translated.overrides)) {
		const classified = classifyKitSettingKey(key, kit);
		if (isProjectSettingClass(classified)) {
			result.project[key] = value;
		} else if (classified.kind === "team") {
			result.team[key] = value;
		} else {
			result.invalid.push({ key, message: classified.message });
		}
	}
	return result;
}

/** Who changed a project setting. */
export type KitSettingsActor =
	| { kind: "user" }
	| { kind: "orchestrator"; taskId: string }
	/** A user-run CLI command that writes in-process (`kit apply`, `kit migrate-overrides`, `kit create|edit`). */
	| { kind: "user-command" };

/** `kit edit` changes the kit itself (src/kits/user-kit-edit.ts); it is logged for every workspace on that kit. */
export type KitSettingsVia = "kit set" | "kit unset" | "kit apply" | "kit migrate-overrides" | "kit edit";

export interface KitSettingsHistoryEntry {
	at: string;
	workspaceId: string;
	kitName: string;
	key: string;
	/** Absent: the key was not set before. */
	from?: unknown;
	/** Absent: the key is removed. */
	to?: unknown;
	by: KitSettingsActor;
	via: KitSettingsVia;
}

export async function appendKitSettingsHistory(
	entries: KitSettingsHistoryEntry[],
	path: string = getKitSettingsHistoryPath(entries[0]?.workspaceId ?? ""),
): Promise<void> {
	if (entries.length === 0) {
		return;
	}
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
}

export async function readKitSettingsHistory(path: string): Promise<KitSettingsHistoryEntry[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	return text.split("\n").flatMap((line) => {
		if (!line.trim()) {
			return [];
		}
		try {
			return [JSON.parse(line) as KitSettingsHistoryEntry];
		} catch {
			return [];
		}
	});
}

/** The changes between two override sets, as history entries. */
export function diffOverridesForHistory(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	base: Omit<KitSettingsHistoryEntry, "key" | "from" | "to">,
): KitSettingsHistoryEntry[] {
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	return keys.flatMap((key) => {
		const had = Object.hasOwn(before, key);
		const has = Object.hasOwn(after, key);
		if (had && has && isDeepStrictEqual(before[key], after[key])) {
			return [];
		}
		return [{ ...base, key, ...(had ? { from: before[key] } : {}), ...(has ? { to: after[key] } : {}) }];
	});
}

export interface KitSettingChangeInput {
	workspaceId: string;
	key: string;
	by: KitSettingsActor;
	configPath?: string;
	kitsDir?: string;
	historyPath?: string;
	now?: () => Date;
}

export interface KitSettingChangeResult {
	workspaceId: string;
	kitName: string;
	key: string;
	/** Every stored key that changed (a legacy key the new key replaces is removed). */
	changes: KitSettingsHistoryEntry[];
	historyPath: string;
}

/** Thrown for a change the caller asked for that isn't allowed or doesn't validate (not for I/O failures). */
export class KitSettingRefusedError extends Error {}

async function changeProjectSettings(
	input: KitSettingChangeInput & { via: "kit set" | "kit unset" },
	plan: (context: {
		kit: KitDocument;
		kitName: string;
		overrides: Record<string, unknown>;
	}) => Record<string, unknown>,
): Promise<KitSettingChangeResult> {
	const [{ config }, catalog] = await Promise.all([
		readPipelineConfig(input.configPath),
		loadKitCatalog(input.kitsDir),
	]);
	const kitRef = getWorkspacePipelineSettings(config, input.workspaceId).kit;
	const kitName = kitRef?.name ?? DEFAULT_KIT_NAME;
	const preset = kitRef?.preset ?? null;
	const team = resolveKitByName(catalog, kitName, {}, preset);
	if (!team.ok) {
		throw new KitSettingRefusedError(`kit ${kitName} of ${input.workspaceId} does not resolve: ${team.error}`);
	}
	let changes: KitSettingsHistoryEntry[] = [];
	const at = (input.now?.() ?? new Date()).toISOString();
	await updateWorkspacePipelineEntry(
		input.workspaceId,
		(entry) => {
			const currentKit = entry.kit && typeof entry.kit === "object" ? (entry.kit as Record<string, unknown>) : {};
			const storedName = typeof currentKit.name === "string" ? currentKit.name : DEFAULT_KIT_NAME;
			const storedPreset = typeof currentKit.preset === "string" ? currentKit.preset : null;
			// A renamed kit's old name is the same kit and preset (the write below stores the new pair).
			const renamed = getRenamedKit(storedName);
			const stored = renamed
				? { name: renamed.name, preset: storedPreset ?? renamed.preset }
				: { name: storedName, preset: storedPreset };
			if (stored.name !== kitName || stored.preset !== preset) {
				throw new KitSettingRefusedError(`workspaces.${input.workspaceId}.kit changed meanwhile; run it again.`);
			}
			const before =
				currentKit.overrides && typeof currentKit.overrides === "object"
					? (currentKit.overrides as Record<string, unknown>)
					: {};
			const after = plan({ kit: team.kit, kitName, overrides: before });
			const resolved = resolveKitByName(catalog, kitName, after, preset);
			if (!resolved.ok) {
				throw new KitSettingRefusedError(`${input.key}: kit ${kitName} would not resolve: ${resolved.error}`);
			}
			changes = diffOverridesForHistory(before, after, {
				at,
				workspaceId: input.workspaceId,
				kitName,
				by: input.by,
				via: input.via,
			});
			// No kit entry means `default`, so `default` without settings is written as no entry.
			if (kitName === DEFAULT_KIT_NAME && Object.keys(after).length === 0) {
				delete entry.kit;
			} else if (kitName === TEAM_KIT_NAME) {
				entry.kit = { name: kitName, preset, overrides: after };
			} else {
				entry.kit = { name: kitName, overrides: after };
			}
			return entry;
		},
		input.configPath,
	);
	const historyPath = input.historyPath ?? getKitSettingsHistoryPath(input.workspaceId);
	await appendKitSettingsHistory(changes, historyPath);
	return {
		workspaceId: input.workspaceId,
		kitName: formatKitSelection({ name: kitName, preset }),
		key: input.key,
		changes,
		historyPath,
	};
}

/** Stored legacy keys whose whole meaning is under `key` (`dev.agent` for `roles.dev.agent`). */
function listLegacyKeysCoveredBy(overrides: Record<string, unknown>, key: string): string[] {
	return translateLegacyOverrides(overrides).renamed.flatMap(({ from, to }) =>
		to.length > 0 && to.every((translated) => isUnder(translated, key)) ? [from] : [],
	);
}

/** `kanban kit set <key> <value>`: one model setting or project fact, validated against the project's kit. */
export async function setProjectKitSetting(
	input: KitSettingChangeInput & { value: unknown },
): Promise<KitSettingChangeResult> {
	return await changeProjectSettings({ ...input, via: "kit set" }, ({ kit, overrides }) => {
		const classified = classifyKitSettingKey(input.key, kit);
		if (classified.kind === "team" || classified.kind === "invalid") {
			throw new KitSettingRefusedError(classified.message);
		}
		const after = { ...overrides };
		for (const legacy of listLegacyKeysCoveredBy(overrides, input.key)) {
			delete after[legacy];
		}
		after[input.key] = input.value;
		return after;
	});
}

/**
 * `kanban kit unset <key>`: removes a project setting (a role field, a whole role `roles.<role>`, a model setting, a
 * fact, or any key whose stored settings are all project settings, such as a whole `qa.routes.0`), so the kit's value
 * applies again. Team keys stored before the split are the user's (`kanban kit migrate-overrides`).
 */
export async function unsetProjectKitSetting(input: KitSettingChangeInput): Promise<KitSettingChangeResult> {
	return await changeProjectSettings({ ...input, via: "kit unset" }, ({ kit, overrides }) => {
		const segments = input.key.split(".");
		const isWholeRole = segments.length === 2 && segments[0] === "roles";
		const classified = isWholeRole
			? classifyKitSettingKey(`${input.key}.agent`, kit)
			: classifyKitSettingKey(input.key, kit);
		const stored = Object.keys(overrides).filter((key) => !isLegacyKitKey(key) && isUnder(key, input.key));
		const allStoredAreProjectSettings =
			stored.length > 0 && stored.every((key) => isProjectSettingClass(classifyKitSettingKey(key, kit)));
		if ((classified.kind === "team" || classified.kind === "invalid") && !allStoredAreProjectSettings) {
			throw new KitSettingRefusedError(classified.message);
		}
		const removed = [...stored, ...listLegacyKeysCoveredBy(overrides, input.key)];
		if (removed.length === 0) {
			throw new KitSettingRefusedError(`${input.workspaceId} has no project setting ${input.key}`);
		}
		const after = { ...overrides };
		for (const key of removed) {
			delete after[key];
		}
		return after;
	});
}

/** For `kanban kit show`: the project settings and team keys of a workspace's stored overrides. */
export function describeProjectSettings(
	catalog: KitCatalog,
	kitName: string,
	overrides: Record<string, unknown>,
	preset: string | null = null,
): ClassifiedOverrides | null {
	const team = resolveKitByName(catalog, kitName, {}, preset);
	return team.ok ? classifyStoredOverrides(overrides, team.kit) : null;
}
