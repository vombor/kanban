// The one place kit files and workspace overrides are read and merged (plan §3.4).
//
// A value comes from, first match wins: the workspace's project settings (`kit.overrides`, dotted key → value,
// src/kits/project-settings.ts) → the preset (`team` kit only, `kits/presets/<name>.json`: its models) → the named
// kit → the `default` kit. Objects merge key by key; arrays and scalars are replaced, not merged. Nothing is inherited from
// another workspace or a top-level key: a workspace without a `kit` entry gets `default`, which answers "no" to
// every routing question. That is the structural fix for the 2026-10-06 incident (a new board got the dev-team
// kit's routing because a project entry inherited the top-level toggles, archive/devteam-kit:lib/config.cjs).
//
// Each layer's legacy keys (`dev.*`, `qa.default`, `escalate.*`, ...) are translated into `roles`/`fallback` before it
// is merged (kit-legacy-keys.ts). A role names a `model` or a `tier`: a layer that sets one drops the other's value from
// the layers below, so a project's `roles.dev.model` replaces the kit's `roles.dev.tier` (a plan candidate's model
// reference the same way). An override key can name a list entry by its index (`tiers.dev.0.model`,
// `qa.routes.1.agent`): it changes that entry of the merged list and never adds one.
//
// Built-in kits (`default`, `team`) and the team kit's presets (`cloud`, `cline`, `lemonade`) ship in the package
// (`kits/*.json`, `kits/presets/*.json`). The team kit is the one workflow every team shares (user 2026-10-12); a
// preset only names models (kitPresetSchema has no workflow key), and `team` without a preset is a custom team whose
// models are the project's role settings. User kits are data files in `$KANBAN_HOME/kits/<name>.json`; a user kit
// with a built-in name, or the old name of a renamed one (renamed-kits.ts), is refused.
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import defaultKitJson from "../../kits/default.json" with { type: "json" };
import clinePresetJson from "../../kits/presets/cline.json" with { type: "json" };
import cloudPresetJson from "../../kits/presets/cloud.json" with { type: "json" };
import lemonadePresetJson from "../../kits/presets/lemonade.json" with { type: "json" };
import teamKitJson from "../../kits/team.json" with { type: "json" };
import { getWorkspacePipelineSettings, type PipelineConfig } from "../config/pipeline-config";
import { getKanbanKitsPath } from "../state/kanban-home";
import { translateLegacyKitLayer, translateLegacyOverrides } from "./kit-legacy-keys";
import {
	formatKitIssues,
	type KitDocument,
	type KitPreset,
	kitDocumentObjectSchema,
	kitDocumentSchema,
	kitPresetSchema,
} from "./kit-schema";
import { describeRenamedKit, formatKitSelection, getRenamedKit, RENAMED_BUILT_IN_KITS } from "./renamed-kits";

export const DEFAULT_KIT_NAME = "default";
/** The kit that holds the team workflow; the only kit with presets. */
export const TEAM_KIT_NAME = "team";
export const BUILT_IN_KIT_NAMES: readonly string[] = [DEFAULT_KIT_NAME, TEAM_KIT_NAME];
/** The team kit's presets, in the order a picker offers them. */
export const BUILT_IN_PRESET_NAMES: readonly string[] = ["cloud", "cline", "lemonade"];

/** True for a built-in kit's name or a renamed one's old name: no user kit may have it. */
export function isReservedKitName(name: string): boolean {
	return BUILT_IN_KIT_NAMES.includes(name) || RENAMED_BUILT_IN_KITS.has(name);
}

/** Keys a workspace override may not set: they identify the kit. */
const NON_OVERRIDABLE_KEYS: ReadonlySet<string> = new Set(["kit", "name", "preset"]);

export type KitOrigin = { kind: "built-in" } | { kind: "user"; path: string };

export interface KitCatalogEntry {
	kit: KitDocument;
	origin: KitOrigin;
}

export interface KitCatalog {
	kits: Map<string, KitCatalogEntry>;
	/** The team kit's presets (built-in only). */
	presets: Map<string, KitPreset>;
	/** User kit files that were refused, with the reason. */
	errors: Array<{ path: string; error: string }>;
}

/** The source of a value a workspace's project settings set. */
export const PROJECT_SETTING_SOURCE = "project";

/** The source of a value a preset sets: `preset:<name>`. */
export function getPresetSettingSource(preset: string): string {
	return `preset:${preset}`;
}

/** Where a resolved value came from: `"project"` (a project setting), `preset:<name>`, the named kit's name, or `"default"`. */
export type KitValueSource = string;

export interface ResolvedKit {
	kit: KitDocument;
	/** Dotted leaf key → source. Arrays and empty objects are leaves. */
	sources: Record<string, KitValueSource>;
}

export type KitResolution = ({ ok: true } & ResolvedKit) | { ok: false; error: string };

export interface WorkspaceKitResolution extends ResolvedKit {
	workspaceId: string;
	/** The kit name in the workspace's config, or null when it has none. */
	requestedKitName: string | null;
	/** The kit actually used (`default` when the requested one is missing or invalid). */
	kitName: string;
	/** The preset in the workspace's config, or null (no preset: a custom team, or another kit). */
	requestedPresetName: string | null;
	/** The preset actually used (null when the kit fell back to `default`). */
	presetName: string | null;
	/** The kit as shown: its name, or `team (<preset>)` / `team (custom)` (formatKitSelection). */
	kitLabel: string;
	/** The project settings as stored (`workspaces.<id>.kit.overrides`, legacy keys included). */
	overrides: Record<string, unknown>;
	issues: string[];
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseBuiltInKit(raw: unknown, name: string): KitDocument {
	const parsed = kitDocumentSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(`Built-in kit ${name} is invalid: ${formatKitIssues(parsed.error)}`);
	}
	return parsed.data;
}

let builtInKits: Map<string, KitDocument> | null = null;

export function getBuiltInKits(): Map<string, KitDocument> {
	builtInKits ??= new Map([
		[DEFAULT_KIT_NAME, parseBuiltInKit(defaultKitJson, DEFAULT_KIT_NAME)],
		[TEAM_KIT_NAME, parseBuiltInKit(teamKitJson, TEAM_KIT_NAME)],
	]);
	return builtInKits;
}

function parseBuiltInPreset(raw: unknown, name: string): KitPreset {
	const parsed = kitPresetSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(`Built-in preset ${name} is invalid: ${formatKitIssues(parsed.error)}`);
	}
	if (parsed.data.name !== name) {
		throw new Error(`Built-in preset ${name} is named "${parsed.data.name}"`);
	}
	return parsed.data;
}

let builtInPresets: Map<string, KitPreset> | null = null;

/** The team kit's presets; each must resolve over the team kit (checked here, so a broken preset fails at once). */
export function getBuiltInPresets(): Map<string, KitPreset> {
	if (!builtInPresets) {
		const presets = new Map([
			["cloud", parseBuiltInPreset(cloudPresetJson, "cloud")],
			["cline", parseBuiltInPreset(clinePresetJson, "cline")],
			["lemonade", parseBuiltInPreset(lemonadePresetJson, "lemonade")],
		]);
		const team = getBuiltInKits().get(TEAM_KIT_NAME);
		for (const [name, preset] of presets) {
			const resolved = team ? resolveKitLayers(getDefaultKit(), team, {}, preset) : null;
			if (!resolved?.ok) {
				throw new Error(`Built-in preset ${name} does not resolve: ${resolved ? resolved.error : "no team kit"}`);
			}
		}
		builtInPresets = presets;
	}
	return builtInPresets;
}

export function getDefaultKit(): KitDocument {
	const kit = getBuiltInKits().get(DEFAULT_KIT_NAME);
	if (!kit) {
		throw new Error("The built-in default kit is missing.");
	}
	return kit;
}

/** Validates a user kit file's content. `fileName` is the file's base name without `.json`. */
export function parseUserKit(
	raw: unknown,
	fileName: string,
): { ok: true; kit: KitDocument } | { ok: false; error: string } {
	const parsed = kitDocumentObjectSchema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, error: formatKitIssues(parsed.error) };
	}
	if (isReservedKitName(parsed.data.name)) {
		const renamed = getRenamedKit(parsed.data.name);
		return {
			ok: false,
			error: renamed
				? `"${parsed.data.name}" is the old name of a built-in kit (${describeRenamedKit(parsed.data.name, renamed)}); a user kit can't take it`
				: `"${parsed.data.name}" is a built-in kit name; a user kit can't replace it`,
		};
	}
	if (parsed.data.name !== fileName) {
		return { ok: false, error: `the kit is named "${parsed.data.name}" but the file is ${fileName}.json` };
	}
	// The cross-key checks run on the kit as it resolves (over the default kit), as every workspace will see it.
	const resolved = resolveKitLayers(getDefaultKit(), parsed.data, {});
	return resolved.ok ? { ok: true, kit: parsed.data } : { ok: false, error: resolved.error };
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export async function loadKitCatalog(kitsDir: string = getKanbanKitsPath()): Promise<KitCatalog> {
	const kits = new Map<string, KitCatalogEntry>();
	for (const [name, kit] of getBuiltInKits()) {
		kits.set(name, { kit, origin: { kind: "built-in" } });
	}
	const presets = new Map(getBuiltInPresets());
	const errors: KitCatalog["errors"] = [];
	let fileNames: string[];
	try {
		fileNames = (await readdir(kitsDir)).filter((fileName) => fileName.endsWith(".json")).sort();
	} catch (error) {
		// No kits dir is normal; an unreadable one is reported, and the built-in kits still work.
		if (!isMissingFileError(error)) {
			errors.push({ path: kitsDir, error: error instanceof Error ? error.message : String(error) });
		}
		return { kits, presets, errors };
	}
	for (const fileName of fileNames) {
		const path = join(kitsDir, fileName);
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(path, "utf8"));
		} catch (error) {
			errors.push({ path, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		const parsed = parseUserKit(raw, basename(fileName, ".json"));
		if (parsed.ok) {
			kits.set(parsed.kit.name, { kit: parsed.kit, origin: { kind: "user", path } });
		} else {
			errors.push({ path, error: parsed.error });
		}
	}
	return { kits, presets, errors };
}

function mergeLayers(base: unknown, layer: unknown): unknown {
	if (!isPlainObject(base) || !isPlainObject(layer)) {
		return structuredClone(layer);
	}
	const merged: PlainObject = { ...structuredClone(base) };
	for (const [key, value] of Object.entries(layer)) {
		merged[key] = Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : structuredClone(value);
	}
	return merged;
}

/** `model` and `tier` exclude each other in a role: the one a layer sets drops the other from the layers below. */
function dropReplacedRoleChoice(role: PlainObject, setField: string): void {
	if (setField === "model") {
		delete role.tier;
	} else if (setField === "tier") {
		delete role.model;
		delete role.provider;
	}
}

/** `base` with `layer` merged on top (both legacy-free). */
function mergeKitLayer(base: PlainObject, layer: PlainObject): PlainObject {
	const merged = mergeLayers(base, layer) as PlainObject;
	const layerRoles = isPlainObject(layer.roles) ? layer.roles : {};
	const mergedRoles = isPlainObject(merged.roles) ? merged.roles : {};
	for (const [name, layerRole] of Object.entries(layerRoles)) {
		const role = mergedRoles[name];
		if (!isPlainObject(layerRole) || !isPlainObject(role)) {
			continue;
		}
		const hasModel = Object.hasOwn(layerRole, "model");
		const hasTier = Object.hasOwn(layerRole, "tier");
		if (hasModel !== hasTier) {
			dropReplacedRoleChoice(role, hasModel ? "model" : "tier");
		}
	}
	// A layer's recommended settings add to the ones below (a preset's provider settings next to the team's recovery
	// settings); the same key is the layer's.
	const baseSettings = readRecommendedSettings(base);
	const layerSettings = readRecommendedSettings(layer);
	if (baseSettings.length > 0 && layerSettings.length > 0) {
		const layerKeys = new Set(layerSettings.map((setting) => setting.key));
		(merged.recommends as PlainObject).settings = [
			...structuredClone(baseSettings.filter((setting) => !layerKeys.has(setting.key))),
			...structuredClone(layerSettings),
		];
	}
	return merged;
}

function readRecommendedSettings(layer: PlainObject): Array<PlainObject & { key: unknown }> {
	const settings = isPlainObject(layer.recommends) ? layer.recommends.settings : undefined;
	return Array.isArray(settings)
		? settings.filter((setting): setting is PlainObject & { key: unknown } => isPlainObject(setting))
		: [];
}

function splitOverrideKey(key: string): string[] | string {
	const segments = key.split(".");
	if (segments.some((segment) => segment.length === 0)) {
		return `override key "${key}" has an empty segment`;
	}
	const [first] = segments;
	if (first && NON_OVERRIDABLE_KEYS.has(first)) {
		return `override key "${key}" can't be overridden (it identifies the kit)`;
	}
	return segments;
}

/**
 * A key whose leaf picks a model or a tier in a model choice: a role (`roles.<role>.<field>`) or a plan candidate's
 * model reference (`plan.candidates.<i>.model.<field>`). Setting one drops the other (`dropReplacedRoleChoice`).
 */
function isModelChoiceKey(segments: string[]): boolean {
	return (
		(segments.length === 3 && segments[0] === "roles") ||
		(segments.length === 5 && segments[0] === "plan" && segments[1] === "candidates" && segments[3] === "model")
	);
}

/** The list entry `segment` names, or an error: a list is never grown by an override, only its entries changed. */
function readListIndex(list: unknown[], segment: string, key: string, at: string[]): number | string {
	const index = /^\d+$/u.test(segment) ? Number(segment) : Number.NaN;
	if (!Number.isInteger(index) || index >= list.length) {
		return `override key "${key}" names entry ${segment} of ${at.join(".")}, which has ${list.length} entr${list.length === 1 ? "y" : "ies"}`;
	}
	return index;
}

function applyOverride(target: PlainObject, key: string, value: unknown): string | null {
	const segments = splitOverrideKey(key);
	if (typeof segments === "string") {
		return segments;
	}
	let node: PlainObject | unknown[] = target;
	for (const [position, segment] of segments.slice(0, -1).entries()) {
		let next: unknown;
		if (Array.isArray(node)) {
			const index = readListIndex(node, segment, key, segments.slice(0, position));
			if (typeof index === "string") {
				return index;
			}
			next = node[index];
		} else {
			next = node[segment];
			if (next === undefined || next === null) {
				next = {};
				node[segment] = next;
			}
		}
		if (!isPlainObject(next) && !Array.isArray(next)) {
			return `override key "${key}" goes through ${segment}, which is not an object`;
		}
		node = next;
	}
	const leaf = segments[segments.length - 1] as string;
	if (Array.isArray(node)) {
		const index = readListIndex(node, leaf, key, segments.slice(0, -1));
		if (typeof index === "string") {
			return index;
		}
		node[index] = structuredClone(value);
		return null;
	}
	if (isModelChoiceKey(segments)) {
		dropReplacedRoleChoice(node, leaf);
	}
	node[leaf] = structuredClone(value);
	return null;
}

function hasPath(value: unknown, segments: string[]): boolean {
	let node = value;
	for (const segment of segments) {
		if (!isPlainObject(node) || !Object.hasOwn(node, segment)) {
			return false;
		}
		node = node[segment];
	}
	return true;
}

/** The value at a dotted key of a kit document (a list entry by its index: `tiers.dev.0.model`), or undefined. */
export function readKitValue(kit: unknown, key: string): unknown {
	let node = kit;
	for (const segment of key.split(".")) {
		if (Array.isArray(node)) {
			node = /^\d+$/u.test(segment) ? node[Number(segment)] : undefined;
		} else if (isPlainObject(node)) {
			node = node[segment];
		} else {
			return undefined;
		}
	}
	return node;
}

function listLeafPaths(value: unknown, prefix: string[] = []): string[][] {
	if (!isPlainObject(value) || (Object.keys(value).length === 0 && prefix.length > 0)) {
		return [prefix];
	}
	return Object.entries(value).flatMap(([key, child]) => listLeafPaths(child, [...prefix, key]));
}

/** A preset as a kit layer: its document without the `preset`/`name`/`description` keys, which identify it. */
function toPresetLayer(preset: KitPreset): PlainObject {
	const { preset: _version, name: _name, description: _description, ...layer } = preset;
	return layer as PlainObject;
}

/**
 * Merges `default` ← `kit` ← `preset` ← `overrides` and validates the result with the full (strict) kit schema, so
 * an unknown override key or a tier without a usable model is an error here.
 */
export function resolveKitLayers(
	defaultKit: KitDocument,
	kit: KitDocument,
	overrides: Record<string, unknown>,
	preset: KitPreset | null = null,
): KitResolution {
	const kitLayer = translateLegacyKitLayer(kit as unknown as PlainObject).layer;
	const presetLayer = preset ? toPresetLayer(preset) : null;
	const kitMerged = mergeKitLayer(translateLegacyKitLayer(defaultKit as unknown as PlainObject).layer, kitLayer);
	const merged = presetLayer ? mergeKitLayer(kitMerged, presetLayer) : kitMerged;
	const projectSettings = translateLegacyOverrides(overrides).overrides;
	for (const [key, value] of Object.entries(projectSettings)) {
		const error = applyOverride(merged, key, value);
		if (error) {
			return { ok: false, error };
		}
	}
	const parsed = kitDocumentSchema.safeParse(merged);
	if (!parsed.success) {
		return { ok: false, error: formatKitIssues(parsed.error) };
	}
	const overrideKeys = Object.keys(projectSettings);
	const sources: Record<string, KitValueSource> = {};
	for (const segments of listLeafPaths(parsed.data)) {
		const key = segments.join(".");
		if (NON_OVERRIDABLE_KEYS.has(key)) {
			continue;
		}
		// A list is a leaf here, so a setting of one of its entries (`tiers.dev.0.model`) makes the list the project's.
		if (
			overrideKeys.some(
				(overrideKey) =>
					key === overrideKey || key.startsWith(`${overrideKey}.`) || overrideKey.startsWith(`${key}.`),
			)
		) {
			sources[key] = PROJECT_SETTING_SOURCE;
		} else if (preset && presetLayer && hasPath(presetLayer, segments)) {
			sources[key] = getPresetSettingSource(preset.name);
		} else if (kit.name !== defaultKit.name && hasPath(kitLayer, segments)) {
			sources[key] = kit.name;
		} else {
			sources[key] = DEFAULT_KIT_NAME;
		}
	}
	return { ok: true, kit: parsed.data, sources };
}

/** Why `preset` can't be used with kit `name`, or null. */
export function describePresetMisuse(catalog: KitCatalog, name: string, preset: string | null): string | null {
	if (preset === null) {
		return null;
	}
	if (name !== TEAM_KIT_NAME) {
		return `kit "${name}" has no presets (only the ${TEAM_KIT_NAME} kit has: ${[...catalog.presets.keys()].join(", ")})`;
	}
	if (!catalog.presets.has(preset)) {
		return `unknown preset "${preset}" (known: ${[...catalog.presets.keys()].join(", ")})`;
	}
	return null;
}

/**
 * A kit by name from the catalog, resolved over `default` with optional overrides; `preset` picks the team kit's
 * models (null: none, the custom team for `team`).
 */
export function resolveKitByName(
	catalog: KitCatalog,
	name: string,
	overrides: Record<string, unknown> = {},
	preset: string | null = null,
): KitResolution {
	const entry = catalog.kits.get(name);
	const renamed = getRenamedKit(name);
	if (!entry && renamed) {
		return { ok: false, error: describeRenamedKit(name, renamed) };
	}
	if (!entry) {
		return { ok: false, error: `unknown kit "${name}" (known: ${[...catalog.kits.keys()].join(", ")})` };
	}
	const misuse = describePresetMisuse(catalog, name, preset);
	if (misuse) {
		return { ok: false, error: misuse };
	}
	return resolveKitLayers(
		getDefaultKit(),
		entry.kit,
		overrides,
		preset ? (catalog.presets.get(preset) ?? null) : null,
	);
}

/**
 * The kit a workspace runs on. Falls back to `default` (with an issue) when the configured kit or preset is missing
 * or its overrides don't validate: `default` answers "no" to everything, which is the safe direction. A config that
 * still names a renamed built-in kit already reads as the kit and preset that replaced it (workspaceKitRefSchema).
 */
export function resolveWorkspaceKit(
	config: PipelineConfig,
	workspaceId: string,
	catalog: KitCatalog,
): WorkspaceKitResolution {
	const kitRef = getWorkspacePipelineSettings(config, workspaceId).kit;
	const requestedKitName = kitRef?.name ?? null;
	const requestedPresetName = kitRef?.preset ?? null;
	const overrides = kitRef?.overrides ?? {};
	const issues: string[] = [];
	if (requestedKitName !== null) {
		const resolved = resolveKitByName(catalog, requestedKitName, overrides, requestedPresetName);
		if (resolved.ok) {
			return {
				workspaceId,
				requestedKitName,
				kitName: requestedKitName,
				requestedPresetName,
				presetName: requestedPresetName,
				kitLabel: formatKitSelection({ name: requestedKitName, preset: requestedPresetName }),
				overrides,
				issues,
				...resolved,
			};
		}
		const label =
			requestedPresetName === null ? requestedKitName : `${requestedKitName}, preset ${requestedPresetName}`;
		issues.push(`workspaces.${workspaceId}.kit (${label}): ${resolved.error}; using the default kit`);
	}
	const fallback = resolveKitLayers(getDefaultKit(), getDefaultKit(), {});
	if (!fallback.ok) {
		throw new Error(`The built-in default kit does not resolve: ${fallback.error}`);
	}
	return {
		workspaceId,
		requestedKitName,
		kitName: DEFAULT_KIT_NAME,
		requestedPresetName,
		presetName: null,
		kitLabel: DEFAULT_KIT_NAME,
		overrides,
		issues,
		kit: fallback.kit,
		sources: fallback.sources,
	};
}
