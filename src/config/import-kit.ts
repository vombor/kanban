// `kanban config import-kit [kit.config.json]` (plan §3.5, used at cutover): maps the legacy kit's config onto
// Kanban's config.json.
//
//   - A project whose own entry turns QA on (toggles.QA_CREATE) gets kit `team`, with every value that differs
//     from kits/team.json as an override (its blurb, QA prompt notes, postLand, …), landing `qa` when it also has
//     AUTO_DONE, and `pipeline.shadow: true` (the pipeline decides and logs, acts on nothing, until P5-2).
//   - Every other project gets no kit (`default`) and landing `off`.
//   - Top-level routing (devAgent, qaAgent, qaRoutes, benchmark, the project toggles) is never copied onto a
//     project: it is compared only for the projects that get `team`. That is the 2026-10-06 incident rule (§4.0).
//   - Machine-wide keys (qaSlots, thresholds, watchdog/orchestrator/provider keys) become core settings (§3.1).
//
// Only keys present in the file are mapped (the kit's built-in defaults are not imported), and the import changes
// only the keys it maps: every other key in config.json stays as it is.
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { KitDocument } from "../kits/kit-schema";
import { getBuiltInKits, loadKitCatalog, readKitValue, resolveKitByName } from "../kits/resolve-kit";
import { getKanbanGlobalConfigPath, getLegacyKitHomePath } from "../state/kanban-home";
import { isPlainRecord, type LegacyKitRaw, listLegacyKitProjects, readLegacyKitConfig } from "./legacy-kit-config";
import {
	type LandingMode,
	migrateLegacyConfigKeys,
	readRawGlobalConfig,
	updatePipelineConfigFile,
} from "./pipeline-config";

export interface ImportedCoreKey {
	/** Dotted core settings key, e.g. `pipeline.qa.slots`. */
	key: string;
	value: unknown;
	/** The kit.config.json key it came from. */
	from: string;
}

export interface ImportedWorkspace {
	workspaceId: string;
	projectPath: string | null;
	/** null: no kit entry (`default`). */
	kit: string | null;
	overrides: Record<string, unknown>;
	landing: LandingMode;
	shadow: boolean;
	defaultBaseRef: string | null;
	name: string | null;
	notes: string[];
}

export interface ImportKitMapping {
	sourcePath: string;
	core: ImportedCoreKey[];
	workspaces: ImportedWorkspace[];
	/** kit.config.json keys with no new home, and why. */
	notImported: Array<{ key: string; why: string }>;
	warnings: string[];
}

const TEAM_KIT_NAME = "team";

// The legacy kit's built-in qaRoutes, used when the file sets none (legacy kit lib/config.cjs DEFAULTS.qaRoutes).
const LEGACY_DEFAULT_QA_ROUTES: unknown[] = [
	{
		devModel: "(^|\\.)openai\\.|^gpt-",
		agent: "cline",
		model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		rules: ["drive"],
		why: "OpenAI-built cards: Haiku 4.5 on Cline (user 10/06 19:5xZ, calibration qa-models-v5..v7)",
	},
];

type Convert = (value: unknown) => unknown;
const asIs: Convert = (value) => value;
const msToSec: Convert = (value) => (typeof value === "number" ? value / 1000 : value);
const toNumberList: Convert = (value) =>
	typeof value === "string"
		? value
				.split(/[\s,]+/u)
				.filter(Boolean)
				.map(Number)
		: value;

// kit.config.json key (dotted) → core key. The env-only knobs of the kit services are not in the file.
const CORE_KEY_MAP: ReadonlyArray<readonly [string, string, Convert?]> = [
	["qaSlots", "pipeline.qa.slots"],
	["thresholds.QA_TIMEOUT_MIN", "pipeline.qa.timeoutMin"],
	["thresholds.QA_NUDGE_MAX", "pipeline.qa.maxNudges"],
	["thresholds.QA_VERDICT_GRACE_MS", "pipeline.qa.verdictGraceSec", msToSec],
	["qaScratchRoot", "pipeline.qa.scratchRoot"],
	["qaOutRoot", "pipeline.qa.outboxRoot"],
	["chromiumLibs", "pipeline.qa.chromiumLibs"],
	["checksRoot", "pipeline.checks.scratchRoot"],
	["thresholds.CHECK_TIMEOUT_MIN", "pipeline.checks.timeoutMin"],
	["thresholds.QAFLOW_MAX_FAILS", "pipeline.rework.maxFailRounds"],
	["thresholds.REWORK_CLEAR_TURNS", "pipeline.rework.clearAfterTurns"],
	["thresholds.REWORK_CLEAR_TOKENS", "pipeline.rework.clearAfterTokens"],
	["thresholds.NUDGE_MAX", "pipeline.recovery.maxNudges"],
	["thresholds.PREMATURE_MAX", "pipeline.recovery.maxContinues"],
	["thresholds.TRANSIENT_BACKOFF_MIN", "pipeline.recovery.retryBackoffMin", toNumberList],
	["thresholds.HUNG_MIN", "pipeline.recovery.hungMin"],
	["thresholds.HUNG_FIRST_MIN", "pipeline.recovery.hungFirstMin"],
	["thresholds.OUTAGE_PROBE_MIN", "pipeline.recovery.outage.probeEveryMin"],
	["thresholds.OUTAGE_UPS", "pipeline.recovery.outage.upsToResume"],
	["thresholds.OUTAGE_MAX_MIN", "pipeline.recovery.outage.maxMin"],
	["thresholds.WATCH_INTERVAL_SEC", "watchdog.intervalSec"],
	["thresholds.STALL_REVIEW_MIN", "watchdog.stall.reviewMin"],
	["thresholds.STALL_QA_MIN", "watchdog.stall.qaMin"],
	["thresholds.STALL_IDLE_MIN", "watchdog.stall.idleMin"],
	["thresholds.RESUME_IDLE_MIN", "watchdog.stall.resumeIdleMin"],
	["thresholds.NEW_CARD_GRACE_MIN", "watchdog.stall.newCardGraceMin"],
	["thresholds.PROMPT_STUCK_MIN", "watchdog.stall.promptMin"],
	["thresholds.TRIAGE_COOLDOWN_MIN", "watchdog.triageCooldownMin"],
	["thresholds.PID_PRESSURE", "watchdog.pids.pressure"],
	["thresholds.PID_BROWNOUT", "watchdog.pids.brownout"],
	["thresholds.PRUNE_DONE_DAYS", "watchdog.pruneDone.days"],
	["thresholds.WAKE_COOLDOWN_MIN", "orchestrator.wake.cooldownMin"],
	["thresholds.ORCH_TIMEOUT_MIN", "orchestrator.wake.timeoutMin"],
	["thresholds.ORCH_LIVE_MIN", "orchestrator.wake.liveSessionMin"],
	["thresholds.BOARD_BACKUP_MIN", "backups.board.everyMin"],
	["thresholds.BOARD_BACKUP_KEEP", "backups.board.keep"],
	["toggles.TRIAGE_CARDS", "watchdog.triageCards"],
	["toggles.PRUNE_DONE", "watchdog.pruneDone.enabled"],
	["toggles.WAKE_ORCHESTRATOR", "orchestrator.wake.enabled"],
	["toggles.PRETRUST", "agents.pretrust"],
	["wakeMode", "orchestrator.wake.mode"],
	["wakeTarget", "orchestrator.wake.target"],
	["providers.default", "models.providers.default"],
	["providers.fallback", "models.providers.fallback"],
	["providers.deprecated", "models.providers.deprecated"],
	["bedrockRegion", "models.bedrockRegion"],
	["modelLists.lemonadeUrl", "models.lists.lemonade.url"],
	["modelLists.requireLabels", "models.lists.lemonade.requireLabels"],
];

// Keys whose job is gone or moved somewhere fixed (§3.1 "D" rows), and the routing keys that only feed `team`.
const NOT_IMPORTED: Readonly<Record<string, string>> = {
	kanbanUrl: "in-process: no client URL",
	runtimeUrl: "in-process: no client URL",
	kanbanCli: "in-process: one Kanban",
	syncIntervalSec: "session sync runs on state events",
	logs: "fixed paths under the Kanban home",
	runDir: "fixed path under the Kanban home",
	dataRoot: "fixed: <home>/data",
	pricesDir: "fixed: <home>/data/prices",
	boardBackupDir: "fixed: <home>/backups/boards",
	kanbanHome: "KANBAN_HOME (kanban home migrate)",
	worktrees: "worktreesRoot / legacyWorktreeRoots in config.json (kanban home migrate)",
	clineSessions: "agents.cline.dataDir (set by hand if it isn't ~/.cline/data)",
	codexSessions: "agents.codex.home (set by hand if it isn't ~/.codex)",
	clineProviders: "agents.cline.dataDir (set by hand if it isn't ~/.cline/data)",
	"modelLists.port": "the model-lists route is on the Kanban server",
	"providers.legacyUpstream": "dropped (upstream Kanban's embedded Cline only)",
	devAgent: "routing: only compared for projects that get kit team (dev.agent)",
	qaAgent: "routing: only compared for projects that get kit team (qa.default.agent)",
	qaRoutes: "routing: only compared for projects that get kit team (qa.routes)",
	benchmark: "routing: only compared for projects that get kit team (tiers, dropped, tierRules, tierNotes)",
	pricesRegion: "team kit data: only compared for projects that get kit team (prices.region)",
	"toggles.PRICE_SYNC": "team kit data: only compared for projects that get kit team (prices.autoSync)",
	"toggles.QA_CREATE": "never copied onto a project (no inheritance since K-1)",
	"toggles.AUTO_REWORK": "never copied onto a project (no inheritance since K-1)",
	"toggles.AUTO_DONE": "never copied onto a project (no inheritance since K-1)",
};

function readDotted(raw: unknown, key: string): unknown {
	let current = raw;
	for (const segment of key.split(".")) {
		if (!isPlainRecord(current)) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

function setDotted(target: Record<string, unknown>, key: string, value: unknown): void {
	const segments = key.split(".");
	let current = target;
	for (const segment of segments.slice(0, -1)) {
		if (!isPlainRecord(current[segment])) {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}
	current[segments[segments.length - 1] as string] = value;
}

function isCommentKey(key: string): boolean {
	return key.startsWith("//");
}

/** Every dotted leaf key of the file's top level (comment keys skipped), for the "not imported" report. */
function listTopLevelKeys(raw: LegacyKitRaw): string[] {
	const keys: string[] = [];
	for (const [key, value] of Object.entries(raw)) {
		if (isCommentKey(key) || key === "projects") {
			continue;
		}
		if (["thresholds", "toggles", "providers", "modelLists"].includes(key) && isPlainRecord(value)) {
			keys.push(
				...Object.keys(value)
					.filter((child) => !isCommentKey(child))
					.map((child) => `${key}.${child}`),
			);
		} else {
			keys.push(key);
		}
	}
	return keys;
}

function mapCoreKeys(raw: LegacyKitRaw): { core: ImportedCoreKey[]; notImported: ImportKitMapping["notImported"] } {
	const core: ImportedCoreKey[] = [];
	const mapped = new Set<string>();
	const kitHome = getLegacyKitHomePath();
	for (const [from, key, convert = asIs] of CORE_KEY_MAP) {
		const value = readDotted(raw, from);
		if (value === undefined) {
			continue;
		}
		mapped.add(from);
		const converted = convert(value);
		core.push({
			key,
			value: typeof converted === "string" ? converted.replaceAll("<kitHome>", kitHome) : converted,
			from,
		});
	}
	const notImported = listTopLevelKeys(raw)
		.filter((key) => !mapped.has(key))
		.map((key) => ({ key, why: NOT_IMPORTED[key] ?? "no Kanban setting (unknown to the import)" }));
	return { core, notImported };
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The legacy kit's agent ids: "cline-cli" was the Cline CLI's id on forks 1-2. */
function normalizeAgentId(value: unknown): unknown {
	return value === "cline-cli" ? "cline" : value;
}

/** A project's effective legacy value: its own entry, else the top level (as lib/config.cjs merges them). */
function projectOrTop(project: Record<string, unknown>, raw: LegacyKitRaw, key: string): unknown {
	const own = readDotted(project, key);
	return own !== undefined ? own : readDotted(raw, key);
}

/**
 * The kit-schema values a legacy QA project's routing amounts to (dotted kit key → value). Each is compared with
 * kits/team.json; only the differences become overrides.
 */
function buildTeamEquivalent(
	project: Record<string, unknown>,
	raw: LegacyKitRaw,
	notes: string[],
): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	const defaultProvider = nonEmptyString(readDotted(raw, "providers.default")) ?? "bedrock";
	const deprecated = readDotted(raw, "providers.deprecated");
	const deprecatedProviders = new Set(isPlainRecord(deprecated) ? Object.keys(deprecated) : []);
	const providerOf = (provider: unknown): unknown =>
		typeof provider === "string" && deprecatedProviders.has(provider) ? defaultProvider : provider;

	const devAgent = projectOrTop(project, raw, "devAgent");
	if (devAgent !== undefined) {
		values["dev.agent"] = normalizeAgentId(devAgent);
	}
	const qaAgent = projectOrTop(project, raw, "qaAgent");
	if (qaAgent !== undefined) {
		values["qa.default.agent"] = normalizeAgentId(qaAgent);
	}
	const routes = projectOrTop(project, raw, "qaRoutes") ?? LEGACY_DEFAULT_QA_ROUTES;
	if (Array.isArray(routes)) {
		// The kit sent a route's QA card to providers.default; the kit schema names the provider on the route.
		values["qa.routes"] = routes.map((route) =>
			isPlainRecord(route)
				? Object.fromEntries(
						Object.entries({
							devModel: route.devModel,
							agent: normalizeAgentId(route.agent),
							provider: providerOf(route.provider ?? defaultProvider),
							model: route.model,
							rules: route.rules,
							why: route.why,
						}).filter(([, value]) => value !== undefined),
					)
				: route,
		);
	}
	const toggles = isPlainRecord(project.toggles) ? project.toggles : {};
	values["onFail.rework"] = toggles.AUTO_REWORK === true ? "same-model" : "none";
	const maxFails = projectOrTop(project, raw, "thresholds.QAFLOW_MAX_FAILS");
	if (typeof maxFails === "number") {
		values["onFail.reworkRounds"] = maxFails;
	}
	const blurb = nonEmptyString(project.projectBlurb);
	if (blurb) {
		values["qa.blurb"] = blurb;
	}
	for (const [from, to] of [
		["screenshotFallbackNote", "screenshotFallback"],
		["knownBaseIssues", "knownBaseIssues"],
		["dbSetup", "dbSetup"],
	] as const) {
		const note = nonEmptyString(readDotted(project, `qaPrompt.${from}`));
		if (note) {
			values[`qa.promptNotes.${to}`] = note;
		}
	}
	if (typeof project.qaPreview === "string") {
		values["qa.preview"] = project.qaPreview;
	} else if (project.qaPreview !== undefined && project.qaPreview !== null) {
		notes.push("qaPreview is not a string; not imported (qa.preview names the preview to start)");
	}
	if (Array.isArray(project.postLand) && project.postLand.length > 0) {
		values["land.postLand"] = project.postLand;
	}
	const benchmark = projectOrTop(project, raw, "benchmark");
	if (isPlainRecord(benchmark)) {
		if (isPlainRecord(benchmark.tiers)) {
			for (const [tier, entries] of Object.entries(benchmark.tiers)) {
				values[`tiers.${tier}`] = Array.isArray(entries)
					? entries.map((entry) =>
							isPlainRecord(entry) ? { ...entry, provider: providerOf(entry.provider) } : entry,
						)
					: entries;
			}
		}
		if (benchmark.dropped !== undefined) {
			values.dropped = benchmark.dropped;
		}
		for (const key of ["tierRules", "tierNotes"] as const) {
			if (isPlainRecord(benchmark[key])) {
				for (const [name, text] of Object.entries(benchmark[key])) {
					values[`${key}.${name}`] = text;
				}
			}
		}
	}
	const pricesRegion = projectOrTop(project, raw, "pricesRegion");
	if (pricesRegion !== undefined) {
		values["prices.region"] = pricesRegion;
	}
	const priceSync = readDotted(raw, "toggles.PRICE_SYNC");
	if (typeof priceSync === "boolean") {
		values["prices.autoSync"] = priceSync;
	}
	return values;
}

function diffAgainstKit(kit: KitDocument, values: Record<string, unknown>): Record<string, unknown> {
	const overrides: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		if (!isDeepStrictEqual(readKitValue(kit, key), value)) {
			overrides[key] = value;
		}
	}
	return overrides;
}

function mapProject(raw: LegacyKitRaw, project: ReturnType<typeof listLegacyKitProjects>[number]): ImportedWorkspace {
	const notes: string[] = [];
	const entry = project.raw;
	const base = {
		workspaceId: project.workspaceId,
		projectPath: project.projectPath,
		defaultBaseRef: nonEmptyString(entry.baseBranch),
		// The kit defaulted the name to the repo dir name; Kanban does the same, so only a different name is kept.
		name:
			nonEmptyString(entry.name) && (!project.projectPath || entry.name !== basename(project.projectPath))
				? (entry.name as string)
				: null,
		notes,
	};
	const { QA_CREATE, AUTO_REWORK, AUTO_DONE } = project.toggles;
	if (!QA_CREATE) {
		if (AUTO_REWORK || AUTO_DONE) {
			notes.push(
				`toggles ${[AUTO_REWORK && "AUTO_REWORK", AUTO_DONE && "AUTO_DONE"].filter(Boolean).join(", ")} on without QA_CREATE: no QA means nothing to rework or land; mapped to landing off`,
			);
		}
		if (nonEmptyString(entry.projectBlurb)) {
			notes.push("projectBlurb not imported: the default kit runs no QA (kanban kit apply team … --set qa.blurb=…)");
		}
		return { ...base, kit: null, overrides: {}, landing: "off", shadow: false };
	}
	const team = getBuiltInKits().get(TEAM_KIT_NAME);
	if (!team) {
		throw new Error("The built-in team kit is missing.");
	}
	const overrides = diffAgainstKit(team, buildTeamEquivalent(entry, raw, notes));
	if (!AUTO_DONE) {
		notes.push(
			"AUTO_DONE is off (QA without auto-landing): landing qa would land after a PASS, so landing is off; the orchestrator lands (kanban kit apply team --landing qa to change)",
		);
	}
	if (readDotted(entry, "scoreboard") !== undefined) {
		notes.push("scoreboard path not imported: the team scoreboard feature writes data/<id>/scoreboard.jsonl");
	}
	return {
		...base,
		kit: TEAM_KIT_NAME,
		overrides,
		landing: AUTO_DONE ? "qa" : "off",
		// Shadow until the cutover switches the project (P5-2): decide and log, act on nothing.
		shadow: true,
	};
}

/** Pure: the mapping of a parsed kit.config.json. */
export function mapLegacyKitConfig(raw: LegacyKitRaw, sourcePath: string): ImportKitMapping {
	const { core, notImported } = mapCoreKeys(raw);
	const warnings: string[] = [];
	const workspaces = listLegacyKitProjects(raw).map((project) => mapProject(raw, project));
	const projects = Array.isArray(raw.projects) ? raw.projects : [];
	if (projects.length > workspaces.length) {
		warnings.push(`${projects.length - workspaces.length} project entr(y/ies) without a workspaceId skipped`);
	}
	for (const project of listLegacyKitProjects(raw)) {
		const thresholds = project.raw.thresholds;
		if (isPlainRecord(thresholds) && Object.keys(thresholds).some((key) => !isCommentKey(key))) {
			warnings.push(
				`project ${project.workspaceId} sets its own thresholds; core thresholds are machine-wide, so only the top level is imported (QAFLOW_MAX_FAILS feeds the kit's onFail.reworkRounds)`,
			);
		}
	}
	return { sourcePath, core, workspaces, notImported, warnings };
}

export interface ImportKitChange {
	key: string;
	from: unknown;
	to: unknown;
}

export interface ImportKitResult {
	mapping: ImportKitMapping;
	configPath: string;
	/** What would change (dry run) or changed in config.json, by dotted key. */
	changes: ImportKitChange[];
	written: boolean;
}

function buildWorkspaceEntry(current: unknown, workspace: ImportedWorkspace): Record<string, unknown> {
	const entry: Record<string, unknown> = isPlainRecord(current) ? structuredClone(current) : {};
	entry.landing = { ...(isPlainRecord(entry.landing) ? entry.landing : {}), mode: workspace.landing };
	if (workspace.kit === null) {
		delete entry.kit;
	} else {
		entry.kit = { name: workspace.kit, overrides: workspace.overrides };
	}
	if (workspace.shadow) {
		entry.pipeline = { ...(isPlainRecord(entry.pipeline) ? entry.pipeline : {}), shadow: true };
	}
	if (workspace.defaultBaseRef !== null) {
		entry.defaultBaseRef = workspace.defaultBaseRef;
	}
	if (workspace.name !== null) {
		entry.name = workspace.name;
	}
	return entry;
}

/** The config.json content after the import. */
export function applyImportMapping(
	config: Record<string, unknown>,
	mapping: ImportKitMapping,
): Record<string, unknown> {
	const next = structuredClone(config);
	for (const { key, value } of mapping.core) {
		setDotted(next, key, value);
	}
	const workspaces = isPlainRecord(next.workspaces) ? next.workspaces : {};
	for (const workspace of mapping.workspaces) {
		workspaces[workspace.workspaceId] = buildWorkspaceEntry(workspaces[workspace.workspaceId], workspace);
	}
	next.workspaces = workspaces;
	// Keys an older Kanban build wrote in an older form are rewritten in the same write (P2-1's `sessionSync`).
	return migrateLegacyConfigKeys(next).config;
}

function listChanges(before: Record<string, unknown>, after: Record<string, unknown>, mapping: ImportKitMapping) {
	const keys = [
		"sessionSync",
		...mapping.core.map(({ key }) => key),
		...mapping.workspaces.flatMap(({ workspaceId }) =>
			["landing.mode", "kit", "pipeline.shadow", "defaultBaseRef", "name"].map(
				(key) => `workspaces.${workspaceId}.${key}`,
			),
		),
	];
	const changes: ImportKitChange[] = [];
	for (const key of keys) {
		// Workspace ids can contain dots; read the entry first, then its key.
		const match = /^workspaces\.(.+?)\.(landing\.mode|kit|pipeline\.shadow|defaultBaseRef|name)$/u.exec(key);
		const read = (config: Record<string, unknown>) =>
			match
				? readDotted(
						isPlainRecord(config.workspaces) ? config.workspaces[match[1] as string] : undefined,
						match[2] as string,
					)
				: readDotted(config, key);
		const from = read(before);
		const to = read(after);
		if (!isDeepStrictEqual(from, to)) {
			changes.push({ key, from, to });
		}
	}
	return changes;
}

/** Reads kit.config.json, maps it, and (unless `dryRun`) writes the mapped keys into config.json. */
export async function importLegacyKitConfig(input: {
	sourcePath?: string;
	dryRun: boolean;
	configPath?: string;
}): Promise<ImportKitResult> {
	const source = await readLegacyKitConfig(input.sourcePath);
	if (source.raw === null) {
		throw new Error(source.error ? `${source.path}: ${source.error}` : `${source.path} does not exist.`);
	}
	const mapping = mapLegacyKitConfig(source.raw, source.path);
	const catalog = await loadKitCatalog();
	for (const workspace of mapping.workspaces) {
		if (workspace.kit !== null) {
			const resolved = resolveKitByName(catalog, workspace.kit, workspace.overrides);
			if (!resolved.ok) {
				throw new Error(
					`workspaces.${workspace.workspaceId}: kit ${workspace.kit} does not resolve: ${resolved.error}`,
				);
			}
		}
	}
	const configPath = input.configPath ?? getKanbanGlobalConfigPath();
	if (input.dryRun) {
		const config = await readRawGlobalConfig(configPath);
		return {
			mapping,
			configPath,
			changes: listChanges(config, applyImportMapping(config, mapping), mapping),
			written: false,
		};
	}
	let changes: ImportKitChange[] = [];
	await updatePipelineConfigFile((config) => {
		const next = applyImportMapping(config, mapping);
		changes = listChanges(config, next, mapping);
		return next;
	}, configPath);
	return { mapping, configPath, changes, written: true };
}
