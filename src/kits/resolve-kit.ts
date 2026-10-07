// The one place kit files and workspace overrides are read and merged (plan §3.4).
//
// A value comes from, first match wins: the workspace's `kit.overrides` (dotted key → value) → the named kit → the
// `default` kit. Objects merge key by key; arrays and scalars are replaced, not merged. Nothing is inherited from
// another workspace or a top-level key: a workspace without a `kit` entry gets `default`, which answers "no" to
// every routing question. That is the structural fix for the 2026-10-06 incident (a new board got the dev-team
// kit's routing because a project entry inherited the top-level toggles, archive/devteam-kit:lib/config.cjs).
//
// Built-in kits (`default`, `team`) ship in the package (`kits/*.json`). User kits are data files in
// `$KANBAN_HOME/kits/<name>.json`; a user kit with a built-in name is refused.
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import defaultKitJson from "../../kits/default.json" with { type: "json" };
import teamKitJson from "../../kits/team.json" with { type: "json" };
import { getWorkspacePipelineSettings, type PipelineConfig } from "../config/pipeline-config";
import { getKanbanKitsPath } from "../state/kanban-home";
import { formatKitIssues, type KitDocument, kitDocumentObjectSchema, kitDocumentSchema } from "./kit-schema";

export const DEFAULT_KIT_NAME = "default";
export const BUILT_IN_KIT_NAMES: readonly string[] = ["default", "team"];

/** Keys a workspace override may not set: they identify the kit. */
const NON_OVERRIDABLE_KEYS: ReadonlySet<string> = new Set(["kit", "name"]);

export type KitOrigin = { kind: "built-in" } | { kind: "user"; path: string };

export interface KitCatalogEntry {
	kit: KitDocument;
	origin: KitOrigin;
}

export interface KitCatalog {
	kits: Map<string, KitCatalogEntry>;
	/** User kit files that were refused, with the reason. */
	errors: Array<{ path: string; error: string }>;
}

/** Where a resolved value came from: `"override"`, the named kit's name, or `"default"`. */
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
		["default", parseBuiltInKit(defaultKitJson, "default")],
		["team", parseBuiltInKit(teamKitJson, "team")],
	]);
	return builtInKits;
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
	if (BUILT_IN_KIT_NAMES.includes(parsed.data.name)) {
		return { ok: false, error: `"${parsed.data.name}" is a built-in kit name; a user kit can't replace it` };
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
	const errors: KitCatalog["errors"] = [];
	let fileNames: string[];
	try {
		fileNames = (await readdir(kitsDir)).filter((fileName) => fileName.endsWith(".json")).sort();
	} catch (error) {
		// No kits dir is normal; an unreadable one is reported, and the built-in kits still work.
		if (!isMissingFileError(error)) {
			errors.push({ path: kitsDir, error: error instanceof Error ? error.message : String(error) });
		}
		return { kits, errors };
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
	return { kits, errors };
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

function applyOverride(target: PlainObject, key: string, value: unknown): string | null {
	const segments = splitOverrideKey(key);
	if (typeof segments === "string") {
		return segments;
	}
	let node: PlainObject = target;
	for (const segment of segments.slice(0, -1)) {
		const next = node[segment];
		if (next === undefined || next === null) {
			const created: PlainObject = {};
			node[segment] = created;
			node = created;
		} else if (isPlainObject(next)) {
			node = next;
		} else {
			return `override key "${key}" goes through ${segment}, which is not an object`;
		}
	}
	node[segments[segments.length - 1] as string] = structuredClone(value);
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

/** The value at a dotted key of a kit document, or undefined. */
export function readKitValue(kit: unknown, key: string): unknown {
	let node = kit;
	for (const segment of key.split(".")) {
		if (!isPlainObject(node)) {
			return undefined;
		}
		node = node[segment];
	}
	return node;
}

function listLeafPaths(value: unknown, prefix: string[] = []): string[][] {
	if (!isPlainObject(value) || (Object.keys(value).length === 0 && prefix.length > 0)) {
		return [prefix];
	}
	return Object.entries(value).flatMap(([key, child]) => listLeafPaths(child, [...prefix, key]));
}

/**
 * Merges `default` ← `kit` ← `overrides` and validates the result with the full (strict) kit schema, so an unknown
 * override key or a tier without a usable model is an error here.
 */
export function resolveKitLayers(
	defaultKit: KitDocument,
	kit: KitDocument,
	overrides: Record<string, unknown>,
): KitResolution {
	const merged = mergeLayers(defaultKit, kit) as PlainObject;
	for (const [key, value] of Object.entries(overrides)) {
		const error = applyOverride(merged, key, value);
		if (error) {
			return { ok: false, error };
		}
	}
	const parsed = kitDocumentSchema.safeParse(merged);
	if (!parsed.success) {
		return { ok: false, error: formatKitIssues(parsed.error) };
	}
	const overrideKeys = Object.keys(overrides);
	const sources: Record<string, KitValueSource> = {};
	for (const segments of listLeafPaths(parsed.data)) {
		const key = segments.join(".");
		if (NON_OVERRIDABLE_KEYS.has(key)) {
			continue;
		}
		if (overrideKeys.some((overrideKey) => key === overrideKey || key.startsWith(`${overrideKey}.`))) {
			sources[key] = "override";
		} else if (kit.name !== defaultKit.name && hasPath(kit, segments)) {
			sources[key] = kit.name;
		} else {
			sources[key] = DEFAULT_KIT_NAME;
		}
	}
	return { ok: true, kit: parsed.data, sources };
}

/** A kit by name from the catalog, resolved over `default` with optional overrides. */
export function resolveKitByName(
	catalog: KitCatalog,
	name: string,
	overrides: Record<string, unknown> = {},
): KitResolution {
	const entry = catalog.kits.get(name);
	if (!entry) {
		return { ok: false, error: `unknown kit "${name}" (known: ${[...catalog.kits.keys()].join(", ")})` };
	}
	return resolveKitLayers(getDefaultKit(), entry.kit, overrides);
}

/**
 * The kit a workspace runs on. Falls back to `default` (with an issue) when the configured kit is missing or its
 * overrides don't validate: `default` answers "no" to everything, which is the safe direction.
 */
export function resolveWorkspaceKit(
	config: PipelineConfig,
	workspaceId: string,
	catalog: KitCatalog,
): WorkspaceKitResolution {
	const kitRef = getWorkspacePipelineSettings(config, workspaceId).kit;
	const requestedKitName = kitRef?.name ?? null;
	const overrides = kitRef?.overrides ?? {};
	const issues: string[] = [];
	if (requestedKitName !== null) {
		const resolved = resolveKitByName(catalog, requestedKitName, overrides);
		if (resolved.ok) {
			return { workspaceId, requestedKitName, kitName: requestedKitName, overrides, issues, ...resolved };
		}
		issues.push(`workspaces.${workspaceId}.kit (${requestedKitName}): ${resolved.error}; using the default kit`);
	}
	const fallback = resolveKitLayers(getDefaultKit(), getDefaultKit(), {});
	if (!fallback.ok) {
		throw new Error(`The built-in default kit does not resolve: ${fallback.error}`);
	}
	return {
		workspaceId,
		requestedKitName,
		kitName: DEFAULT_KIT_NAME,
		overrides,
		issues,
		kit: fallback.kit,
		sources: fallback.sources,
	};
}
