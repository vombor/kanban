// `kanban kit create` and `kanban kit edit` (the user's commands, USER_ONLY_COMMANDS): the only Kanban code that writes
// a user kit file (`$KANBAN_HOME/kits/<name>.json`) besides `kit migrate-overrides`. Both run in-process: a kit file
// is the user's data, and the CLI refuses both commands from every agent session.
//
// There is no inheritance (a kit resolves only over `default`), so `create` writes the `--from` kit as it resolves
// over `default`, a complete copy, with the `--set` keys applied the way the resolver applies them (a role's `model`
// replaces its `tier` and back). `edit` changes keys of an existing user kit, never a built-in one; workspaces on the
// kit read it at their next routing decision, so the edit is refused when it would newly route one of them to a
// combination the vetted model registry refuses (as `kit set` is). Only team-definition keys: `kit`/`name` identify
// the kit, legacy keys have new names, and project facts are each project's (`kanban kit set`).
//
// Every create/edit goes to `<home>/data/kit-history.jsonl`; an edit also goes to the kit settings history of each
// workspace on the kit (via "kit edit"), so `kanban kit show --project` shows it. An edit backs the file up under
// `<home>/backups/kits/` first and replaces it atomically.
import { access, appendFile, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { type PipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	getKanbanKitsPath,
	getKitBackupsPath,
	getKitHistoryPath,
	getKitSettingsHistoryPath,
} from "../state/kanban-home";
import { isLegacyKitKey, translateLegacyOverrides } from "./kit-legacy-keys";
import { type KitDocument, kitDocumentObjectSchema, kitNameSchema } from "./kit-schema";
import {
	appendKitSettingsHistory,
	type KitSettingsActor,
	type KitSettingsHistoryEntry,
	PROJECT_FACT_KEYS,
} from "./project-settings";
import {
	BUILT_IN_KIT_NAMES,
	getDefaultKit,
	type KitCatalog,
	loadKitCatalog,
	parseUserKit,
	resolveKitByName,
	resolveKitLayers,
} from "./resolve-kit";
import { describeRefusedKitRoutes, getWorkspaceRoutingVetting } from "./routing-vetting";

/** Thrown for a create/edit the user asked for that isn't allowed or doesn't validate (not for I/O failures). */
export class UserKitRefusedError extends Error {}

export interface KitKeyChange {
	key: string;
	/** Absent: the kit had no value there. */
	from?: unknown;
	/** Absent: the value is removed. */
	to?: unknown;
}

export interface KitHistoryEntry extends KitKeyChange {
	at: string;
	kitName: string;
	by: KitSettingsActor;
	via: "kit create" | "kit edit";
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUnder(key: string, prefix: string): boolean {
	return key === prefix || key.startsWith(`${prefix}.`);
}

/** Dotted leaf key → value; arrays and empty objects are leaves. */
function flattenKit(value: unknown, prefix: string[] = [], into: PlainObject = {}): PlainObject {
	if (!isPlainObject(value) || (Object.keys(value).length === 0 && prefix.length > 0)) {
		into[prefix.join(".")] = value;
		return into;
	}
	for (const [key, child] of Object.entries(value)) {
		flattenKit(child, [...prefix, key], into);
	}
	return into;
}

/** Leaf by leaf, what differs between two kit documents (their names aside). */
export function diffKitDocuments(before: KitDocument, after: KitDocument): KitKeyChange[] {
	const { name: _beforeName, ...beforeRest } = before;
	const { name: _afterName, ...afterRest } = after;
	const beforeLeaves = flattenKit(beforeRest);
	const afterLeaves = flattenKit(afterRest);
	const keys = [...new Set([...Object.keys(beforeLeaves), ...Object.keys(afterLeaves)])].sort();
	return keys.flatMap((key) => {
		const had = Object.hasOwn(beforeLeaves, key);
		const has = Object.hasOwn(afterLeaves, key);
		if (had && has && isDeepStrictEqual(beforeLeaves[key], afterLeaves[key])) {
			return [];
		}
		return [{ key, ...(had ? { from: beforeLeaves[key] } : {}), ...(has ? { to: afterLeaves[key] } : {}) }];
	});
}

/** Null when a kit command may set or remove `key`; else why not. */
export function checkTeamKitKey(key: string): string | null {
	const segments = key.split(".");
	if (segments.some((segment) => segment.length === 0)) {
		return `"${key}" has an empty segment`;
	}
	const [top] = segments as [string, ...string[]];
	if (!Object.hasOwn(kitDocumentObjectSchema.shape, top)) {
		return `"${key}" is not a kit key`;
	}
	if (top === "kit" || top === "name") {
		return `${key} identifies the kit; it can't be set`;
	}
	if (isLegacyKitKey(key)) {
		const renamed = translateLegacyOverrides({ [key]: null }).renamed[0]?.to ?? [];
		return `${key} is a legacy key${renamed.length > 0 ? `; use ${renamed.join(", ")}` : ""}`;
	}
	const fact = PROJECT_FACT_KEYS.find((prefix) => isUnder(key, prefix) || isUnder(prefix, key));
	if (fact) {
		return `${key} is a project fact (${fact}), not the team's; set it per project with kanban kit set ${fact} <value> --project <path>`;
	}
	return null;
}

function assertTeamKitKeys(keys: string[], flag: "--set" | "--unset"): void {
	const problems = keys.flatMap((key) => {
		const problem = checkTeamKitKey(key);
		return problem ? [`${flag} ${problem}`] : [];
	});
	if (problems.length > 0) {
		throw new UserKitRefusedError(problems.join("; "));
	}
}

/** A clone of `kit` without the value at dotted `key`; refused when the kit has none. */
function withoutKey(kit: KitDocument, key: string): KitDocument {
	const clone = structuredClone(kit) as unknown as PlainObject;
	const segments = key.split(".");
	let node: unknown = clone;
	for (const segment of segments.slice(0, -1)) {
		node = isPlainObject(node) ? node[segment] : undefined;
	}
	const leaf = segments[segments.length - 1] as string;
	if (!isPlainObject(node) || !Object.hasOwn(node, leaf)) {
		throw new UserKitRefusedError(`--unset ${key}: kit ${kit.name} has no ${key}`);
	}
	delete node[leaf];
	return clone as unknown as KitDocument;
}

async function pathExists(path: string): Promise<boolean> {
	return await access(path).then(
		() => true,
		() => false,
	);
}

function kitFilePath(name: string, kitsDir: string): string {
	return join(kitsDir, `${name}.json`);
}

function serializeKit(kit: KitDocument): string {
	return `${JSON.stringify(kit, null, "\t")}\n`;
}

/** The kit as written to its file: validated as a user kit named `name`. */
function finishUserKit(kit: KitDocument, name: string): KitDocument {
	const parsed = parseUserKit(kit, name);
	if (!parsed.ok) {
		throw new UserKitRefusedError(`kit ${name} would be invalid: ${parsed.error}`);
	}
	return parsed.kit;
}

export interface UserKitCreatePlan {
	name: string;
	from: string;
	path: string;
	kit: KitDocument;
	/** Against the `--from` kit as it resolves over `default`. */
	changes: KitKeyChange[];
}

export function planUserKitCreate(input: {
	catalog: KitCatalog;
	name: string;
	from: string;
	set?: Record<string, unknown>;
	description?: string;
	kitsDir?: string;
}): UserKitCreatePlan {
	const { catalog, name, from } = input;
	const set = input.set ?? {};
	const nameCheck = kitNameSchema.safeParse(name);
	if (!nameCheck.success) {
		throw new UserKitRefusedError(`${name}: not a kit name (lowercase letters, digits, '-', '_')`);
	}
	if (BUILT_IN_KIT_NAMES.includes(name)) {
		throw new UserKitRefusedError(`${name} is a built-in kit; pick another name`);
	}
	const path = kitFilePath(name, input.kitsDir ?? getKanbanKitsPath());
	if (catalog.kits.has(name) || catalog.errors.some((error) => error.path === path)) {
		throw new UserKitRefusedError(`kit ${name} already exists (${path}); pick another name or kanban kit edit it`);
	}
	assertTeamKitKeys(Object.keys(set), "--set");
	const base = resolveKitByName(catalog, from);
	if (!base.ok) {
		throw new UserKitRefusedError(`--from ${from}: ${base.error}`);
	}
	const fromKit = catalog.kits.get(from)?.kit;
	if (!fromKit) {
		throw new UserKitRefusedError(`--from ${from}: unknown kit`);
	}
	const resolved = resolveKitLayers(getDefaultKit(), fromKit, set);
	if (!resolved.ok) {
		throw new UserKitRefusedError(`kit ${from} with the --set keys does not resolve: ${resolved.error}`);
	}
	const description =
		input.description ??
		(Object.hasOwn(set, "description")
			? resolved.kit.description
			: `Copy of kit ${from}${Object.keys(set).length > 0 ? ` with ${Object.keys(set).sort().join(", ")} changed` : ""} (kanban kit create)`);
	const kit = finishUserKit({ ...resolved.kit, name, ...(description !== undefined ? { description } : {}) }, name);
	return { name, from, path, kit, changes: diffKitDocuments(base.kit, kit) };
}

export interface KitWorkspaceUse {
	workspaceId: string;
	/** Changed keys this workspace's own project settings set, so its value wins over the kit's. */
	shadowedBy: string[];
}

export interface UserKitEditPlan {
	name: string;
	path: string;
	/** The file as read, which the write checks again under the lock. */
	raw: string;
	before: KitDocument;
	kit: KitDocument;
	changes: KitKeyChange[];
	workspaces: KitWorkspaceUse[];
}

function listKitWorkspaces(config: PipelineConfig, name: string): string[] {
	return Object.entries(config.workspaces)
		.filter(([, settings]) => settings.kit?.name === name)
		.map(([workspaceId]) => workspaceId)
		.sort();
}

export function planUserKitEdit(input: {
	catalog: KitCatalog;
	config: PipelineConfig;
	name: string;
	raw: string;
	set?: Record<string, unknown>;
	unset?: string[];
}): UserKitEditPlan {
	const { catalog, config, name } = input;
	const set = input.set ?? {};
	const unset = input.unset ?? [];
	if (Object.keys(set).length === 0 && unset.length === 0) {
		throw new UserKitRefusedError("nothing to change: give --set <key>=<value> or --unset <key>");
	}
	const entry = catalog.kits.get(name);
	if (!entry) {
		const refused = catalog.errors.find((error) => error.path.endsWith(`/${name}.json`));
		throw new UserKitRefusedError(
			refused ? `kit ${name} is refused (${refused.path}: ${refused.error})` : `unknown kit "${name}"`,
		);
	}
	if (entry.origin.kind === "built-in") {
		throw new UserKitRefusedError(
			`${name} is a built-in kit, which only a Kanban release changes; make your own with kanban kit create <name> --from ${name}`,
		);
	}
	assertTeamKitKeys(Object.keys(set), "--set");
	assertTeamKitKeys(unset, "--unset");
	let edited = entry.kit;
	for (const key of unset) {
		edited = withoutKey(edited, key);
	}
	const resolved = resolveKitLayers(getDefaultKit(), edited, set);
	if (!resolved.ok) {
		throw new UserKitRefusedError(`kit ${name} would not resolve: ${resolved.error}`);
	}
	const kit = finishUserKit(resolved.kit, name);
	const before = resolveKitByName(catalog, name);
	const changes = before.ok ? diffKitDocuments(before.kit, kit) : [];
	const nextCatalog: KitCatalog = {
		kits: new Map([...catalog.kits, [name, { kit, origin: entry.origin }]]),
		errors: catalog.errors,
	};
	const workspaces = listKitWorkspaces(config, name).map((workspaceId): KitWorkspaceUse => {
		const overrides = config.workspaces[workspaceId]?.kit?.overrides ?? {};
		const after = resolveKitByName(nextCatalog, name, overrides);
		if (!after.ok) {
			throw new UserKitRefusedError(`${workspaceId} (on kit ${name}) would not resolve: ${after.error}`);
		}
		// Like kit set: no newly refused route (routes refused before the edit are doctor's to report).
		const vetting = getWorkspaceRoutingVetting(config, workspaceId);
		const current = resolveKitByName(catalog, name, overrides);
		const refusedBefore = new Set(current.ok ? describeRefusedKitRoutes(current.kit, vetting) : []);
		const newlyRefused = describeRefusedKitRoutes(after.kit, vetting).filter((line) => !refusedBefore.has(line));
		if (newlyRefused.length > 0) {
			throw new UserKitRefusedError(`${workspaceId} (on kit ${name}): ${newlyRefused.join("; ")}`);
		}
		const ownKeys = Object.keys(translateLegacyOverrides(overrides).overrides);
		const shadowedBy = ownKeys
			.filter((own) => changes.some((change) => isUnder(change.key, own) || isUnder(own, change.key)))
			.sort();
		return { workspaceId, shadowedBy };
	});
	return { name, path: entry.origin.path, raw: input.raw, before: entry.kit, kit, changes, workspaces };
}

async function appendKitHistory(entries: KitHistoryEntry[], path: string): Promise<void> {
	if (entries.length === 0) {
		return;
	}
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
}

export async function readKitHistory(path: string = getKitHistoryPath()): Promise<KitHistoryEntry[]> {
	const text = await readFile(path, "utf8").catch(() => "");
	return text.split("\n").flatMap((line) => {
		if (!line.trim()) {
			return [];
		}
		try {
			return [JSON.parse(line) as KitHistoryEntry];
		} catch {
			return [];
		}
	});
}

function backupTimestamp(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.(\d+)Z$/u, "$1Z");
}

/** Copies the kit file as it was into `<backupsDir>/<name>.json.<UTC timestamp>` (never over another copy). */
async function backupKitFile(path: string, name: string, backupsDir: string, now: Date): Promise<string> {
	await mkdir(backupsDir, { recursive: true });
	const base = join(backupsDir, `${name}.json.${backupTimestamp(now)}`);
	for (let attempt = 0; ; attempt += 1) {
		const target = attempt === 0 ? base : `${base}-${attempt}`;
		try {
			await copyFile(path, target, 1 /* COPYFILE_EXCL */);
			return target;
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST") || attempt >= 99) {
				throw error;
			}
		}
	}
}

export interface UserKitWriteOptions {
	dryRun?: boolean;
	configPath?: string;
	kitsDir?: string;
	historyPath?: string;
	backupsDir?: string;
	now?: () => Date;
}

const USER_COMMAND: KitSettingsActor = { kind: "user-command" };

export async function createUserKit(
	input: UserKitWriteOptions & {
		name: string;
		from: string;
		set?: Record<string, unknown>;
		description?: string;
	},
): Promise<UserKitCreatePlan & { written: boolean; historyPath: string }> {
	const kitsDir = input.kitsDir ?? getKanbanKitsPath();
	const historyPath = input.historyPath ?? getKitHistoryPath();
	const plan = planUserKitCreate({ ...input, catalog: await loadKitCatalog(kitsDir), kitsDir });
	if (input.dryRun) {
		return { ...plan, written: false, historyPath };
	}
	await mkdir(kitsDir, { recursive: true });
	await lockedFileSystem.withLock({ path: plan.path, type: "file" }, async () => {
		// A file that appeared since the catalog was read is never replaced.
		if (await pathExists(plan.path)) {
			throw new UserKitRefusedError(`kit ${plan.name} already exists (${plan.path}); pick another name`);
		}
		await lockedFileSystem.writeTextFileAtomic(plan.path, serializeKit(plan.kit), { lock: null });
	});
	const at = (input.now?.() ?? new Date()).toISOString();
	const base = { at, kitName: plan.name, by: USER_COMMAND, via: "kit create" as const };
	await appendKitHistory(
		[
			{ ...base, key: "(kit)", to: `created from ${plan.from}` },
			...plan.changes.map((change) => ({ ...base, ...change })),
		],
		historyPath,
	);
	return { ...plan, written: true, historyPath };
}

export async function editUserKit(
	input: UserKitWriteOptions & {
		name: string;
		set?: Record<string, unknown>;
		unset?: string[];
	},
): Promise<UserKitEditPlan & { written: boolean; backupPath: string | null; historyPath: string }> {
	const kitsDir = input.kitsDir ?? getKanbanKitsPath();
	const historyPath = input.historyPath ?? getKitHistoryPath();
	const [catalog, { config }] = await Promise.all([loadKitCatalog(kitsDir), readPipelineConfig(input.configPath)]);
	const path = kitFilePath(input.name, kitsDir);
	const raw = await readFile(path, "utf8").catch(() => "");
	const plan = planUserKitEdit({ catalog, config, name: input.name, raw, set: input.set, unset: input.unset });
	if (input.dryRun || plan.changes.length === 0) {
		return { ...plan, written: false, backupPath: null, historyPath };
	}
	const now = input.now?.() ?? new Date();
	const backupPath = await lockedFileSystem.withLock({ path: plan.path, type: "file" }, async () => {
		if ((await readFile(plan.path, "utf8")) !== plan.raw) {
			throw new UserKitRefusedError(`${plan.path} changed while editing; run the command again.`);
		}
		const copy = await backupKitFile(plan.path, plan.name, input.backupsDir ?? getKitBackupsPath(), now);
		await lockedFileSystem.writeTextFileAtomic(plan.path, serializeKit(plan.kit), { lock: null });
		return copy;
	});
	const at = now.toISOString();
	const base = { at, kitName: plan.name, by: USER_COMMAND };
	await appendKitHistory(
		plan.changes.map((change) => ({ ...base, via: "kit edit" as const, ...change })),
		historyPath,
	);
	for (const { workspaceId } of plan.workspaces) {
		const entries: KitSettingsHistoryEntry[] = plan.changes.map((change) => ({
			...base,
			workspaceId,
			via: "kit edit",
			...change,
		}));
		await appendKitSettingsHistory(entries, getKitSettingsHistoryPath(workspaceId));
	}
	return { ...plan, written: true, backupPath, historyPath };
}

/** For the CLI: a kit value as one short line. */
export function formatKitValue(value: unknown): string {
	return value === undefined ? "(none)" : JSON.stringify(value);
}
