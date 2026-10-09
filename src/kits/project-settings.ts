// A project's settings on top of its kit (docs/team/KITS.md "Project settings"). The kit is the team definition
// (kit-schema.ts); a project only sets
//   - the model of any role its kit defines: `roles.<role>.agent|provider|model|tier` (an unknown role, or one the kit
//     doesn't define, is an error), and
//   - project facts: PROJECT_FACT_KEYS (the QA blurb, QA prompt notes, the QA servers script and preview, post-land
//     commands, plan prompt rules).
// Every other key (onFail, fallback triggers and approval, qa.enabled/routes/rules, requireDifferentVendor, tiers,
// features, ...) is the team: a project changes it only by using another kit (`kanban kit apply`, the user's).
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
import { DEFAULT_KIT_NAME, type KitCatalog, loadKitCatalog, resolveKitByName } from "./resolve-kit";

/** Project facts a project sets on its kit: a key here, or anything under it. */
export const PROJECT_FACT_KEYS = [
	"qa.blurb",
	"qa.promptNotes",
	"qa.serversScript",
	"qa.preview",
	"land.postLand",
	"plan.rules",
] as const;

export type KitSettingKeyClass =
	| { kind: "role"; role: KitRoleName; field: (typeof KIT_ROLE_MODEL_FIELDS)[number] }
	| { kind: "fact" }
	/** Part of the team definition: refused for a project. */
	| { kind: "team"; message: string }
	| { kind: "invalid"; message: string };

function isUnder(key: string, prefix: string): boolean {
	return key === prefix || key.startsWith(`${prefix}.`);
}

function teamKeyMessage(key: string, kitName: string): string {
	return `${key} is part of the team definition (kit ${kitName}), which a project can't change. A project sets only its roles' models (roles.<role>.agent|provider|model|tier) and project facts (${PROJECT_FACT_KEYS.join(", ")}). For another team, the user picks or makes a kit that has it (kanban kit apply <kit>).`;
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
	if (!Object.hasOwn(kitDocumentObjectSchema.shape, top)) {
		return { kind: "invalid", message: `"${key}" is not a kit key` };
	}
	if (top === "kit" || top === "name") {
		return { kind: "invalid", message: `${key} identifies the kit; another kit is the user's kanban kit apply` };
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
	if (PROJECT_FACT_KEYS.some((fact) => isUnder(key, fact))) {
		return { kind: "fact" };
	}
	return { kind: "team", message: teamKeyMessage(key, kit.name) };
}

/** A stored override set split by what it is, after translating its legacy keys. */
export interface ClassifiedOverrides {
	/** Role models and facts (translated keys). */
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
		if (classified.kind === "role" || classified.kind === "fact") {
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
	/** A user-run CLI command that writes in-process (`kit apply`, `kit migrate-overrides`). */
	| { kind: "user-command" };

export type KitSettingsVia = "kit set" | "kit unset" | "kit apply" | "kit migrate-overrides";

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
	const kitName = getWorkspacePipelineSettings(config, input.workspaceId).kit?.name ?? DEFAULT_KIT_NAME;
	const team = resolveKitByName(catalog, kitName);
	if (!team.ok) {
		throw new KitSettingRefusedError(`kit ${kitName} of ${input.workspaceId} does not resolve: ${team.error}`);
	}
	let changes: KitSettingsHistoryEntry[] = [];
	const at = (input.now?.() ?? new Date()).toISOString();
	await updateWorkspacePipelineEntry(
		input.workspaceId,
		(entry) => {
			const currentKit = entry.kit && typeof entry.kit === "object" ? (entry.kit as Record<string, unknown>) : {};
			if ((typeof currentKit.name === "string" ? currentKit.name : DEFAULT_KIT_NAME) !== kitName) {
				throw new KitSettingRefusedError(`workspaces.${input.workspaceId}.kit changed meanwhile; run it again.`);
			}
			const before =
				currentKit.overrides && typeof currentKit.overrides === "object"
					? (currentKit.overrides as Record<string, unknown>)
					: {};
			const after = plan({ kit: team.kit, kitName, overrides: before });
			const resolved = resolveKitByName(catalog, kitName, after);
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
			} else {
				entry.kit = { name: kitName, overrides: after };
			}
			return entry;
		},
		input.configPath,
	);
	const historyPath = input.historyPath ?? getKitSettingsHistoryPath(input.workspaceId);
	await appendKitSettingsHistory(changes, historyPath);
	return { workspaceId: input.workspaceId, kitName, key: input.key, changes, historyPath };
}

/** Stored legacy keys whose whole meaning is under `key` (`dev.agent` for `roles.dev.agent`). */
function listLegacyKeysCoveredBy(overrides: Record<string, unknown>, key: string): string[] {
	return translateLegacyOverrides(overrides).renamed.flatMap(({ from, to }) =>
		to.length > 0 && to.every((translated) => isUnder(translated, key)) ? [from] : [],
	);
}

/** `kanban kit set <key> <value>`: one role model field or project fact, validated against the project's kit. */
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
 * `kanban kit unset <key>`: removes a project setting (a role field, a whole role `roles.<role>`, or a fact), so the
 * kit's value applies again. Team keys stored before the split are the user's (`kanban kit migrate-overrides`).
 */
export async function unsetProjectKitSetting(input: KitSettingChangeInput): Promise<KitSettingChangeResult> {
	return await changeProjectSettings({ ...input, via: "kit unset" }, ({ kit, overrides }) => {
		const segments = input.key.split(".");
		const isWholeRole = segments.length === 2 && segments[0] === "roles";
		const classified = isWholeRole
			? classifyKitSettingKey(`${input.key}.agent`, kit)
			: classifyKitSettingKey(input.key, kit);
		if (classified.kind === "team" || classified.kind === "invalid") {
			throw new KitSettingRefusedError(classified.message);
		}
		const removed = [
			...Object.keys(overrides).filter((key) => !isLegacyKitKey(key) && isUnder(key, input.key)),
			...listLegacyKeysCoveredBy(overrides, input.key),
		];
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
): ClassifiedOverrides | null {
	const team = resolveKitByName(catalog, kitName);
	return team.ok ? classifyStoredOverrides(overrides, team.kit) : null;
}
