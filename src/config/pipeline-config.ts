// Core pipeline settings (plan §3.1): the machine-wide mechanics (`pipeline.*`, `watchdog.*`, `orchestrator.*`,
// `models.*`, `agents.*`, `backups.*`) and the per-workspace mechanics (`workspaces.<id>.*`) in the global
// config.json. They never name an agent or a model for a card: routing is a kit's job (src/kits/), and a workspace
// only says which kit it uses (`workspaces.<id>.kit`). A workspace without an entry is landing `off` on the
// `default` kit, so it behaves like upstream. Nothing is inherited from another workspace or from a top-level key.
//
// Nothing reads these settings to act on cards yet (the pipeline arrives in P4-1); `kanban config show` and
// `kanban kit …` are the only readers. Each top-level section, and each workspace, is parsed on its own: a section
// that doesn't validate falls back to its defaults with an issue, so one typo doesn't reset everything else.
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { type RuntimeLandingMode, runtimeLandingModeSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getKanbanGlobalConfigPath, KANBAN_HOME_MARKER_VERSION, shouldMarkKanbanHome } from "../state/kanban-home";
import { clineTurnDetectorModeSchema, getDefaultClineTurnDetectorSettings } from "./cline-turn-detector-config";
import { DEFAULT_LEMONADE_MODEL_LIST_SETTINGS } from "./model-lists-config";

export const landingModeSchema = runtimeLandingModeSchema;

/**
 * Recovery (src/pipeline/recovery-stage.ts). `off`: nothing is evaluated. `report`: decide and log on pipeline
 * workspaces (landing `qa`), act on nothing. `on`: act (except on shadow workspaces), and also on workspaces with
 * landing `off`/`commit`/`pr` whose `workspaces.<id>.recovery.enabled` is true. `report` until the cutover
 * switches the legacy kit's autoland off: both would nudge and resume the same cards (plan §8.3).
 */
export const recoveryModeSchema = z.enum(["off", "report", "on"]);
export type RecoveryMode = z.infer<typeof recoveryModeSchema>;
export type LandingMode = RuntimeLandingMode;

/** The kit a workspace uses. Overrides are dotted kit keys (`"qa.blurb"`) → value (§3.4). */
export const workspaceKitRefSchema = z
	.object({
		name: z.string().min(1),
		overrides: z.record(z.string(), z.unknown()).default({}),
	})
	.strict();
export type WorkspaceKitRef = z.infer<typeof workspaceKitRefSchema>;

export const workspacePipelineSettingsSchema = z
	.object({
		name: z.string().nullable().default(null),
		defaultBaseRef: z.string().nullable().default(null),
		landing: z
			.object({ mode: landingModeSchema.default("off") })
			.strict()
			.default({ mode: "off" }),
		pipeline: z
			.object({ shadow: z.boolean().default(false) })
			.strict()
			.default({ shadow: false }),
		checks: z
			.object({
				// null: on only when landing is `qa`.
				enabled: z.boolean().nullable().default(null),
				scripts: z.array(z.string()).default(["typecheck", "lint", "test", "build"]),
			})
			.strict()
			.default({ enabled: null, scripts: ["typecheck", "lint", "test", "build"] }),
		recovery: z
			.object({ enabled: z.boolean().default(true) })
			.strict()
			.default({ enabled: true }),
		kit: workspaceKitRefSchema.nullable().default(null),
		// Task-card guardrails (src/guardrails/): null keeps the machine-wide `guardrails.enabled`. The lists are
		// added to the machine-wide ones, so a workspace can only tighten them.
		guardrails: z
			.object({
				enabled: z.boolean().nullable().default(null),
				extraDenyCommands: z.array(z.string().min(1)).default([]),
				extraWritableDirs: z.array(z.string().min(1)).default([]),
			})
			.strict()
			.default({ enabled: null, extraDenyCommands: [], extraWritableDirs: [] }),
	})
	.strict();
export type WorkspacePipelineSettings = z.infer<typeof workspacePipelineSettingsSchema>;

// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (CHECK_ALLOW_SCRIPTS).
const DEFAULT_CHECK_ALLOW_SCRIPTS = ["esbuild", "prisma", "@prisma/engines", "@prisma/client", "sqlite3"] as const;

const pipelineSectionSchema = z
	.object({
		paused: z.boolean().default(false),
		// A newer build for the worker in the dev pod (§5); null = the running package.
		workerEntry: z.string().nullable().default(null),
		qa: z
			.object({
				slots: z.number().int().positive().default(2),
				timeoutMin: z.number().positive().default(60),
				maxNudges: z.number().int().nonnegative().default(2),
				verdictGraceSec: z.number().nonnegative().default(20),
				scratchRoot: z.string().default("/tmp/kanban-qa"),
				outboxRoot: z.string().default("/tmp/kanban-qa-out"),
				chromiumLibs: z.string().nullable().default(null),
				// Minutes with no QA card queued or running before the QA gate stops a preview it started.
				previewIdleMin: z.number().nonnegative().default(5),
			})
			.strict()
			.default({
				slots: 2,
				timeoutMin: 60,
				maxNudges: 2,
				verdictGraceSec: 20,
				scratchRoot: "/tmp/kanban-qa",
				outboxRoot: "/tmp/kanban-qa-out",
				chromiumLibs: null,
				previewIdleMin: 5,
			}),
		// Scripted checks (src/pipeline/checks.ts): one run at a time machine-wide, each step niced and with test
		// runners capped at `maxWorkers` (a full install + test suite per Review card once pegged the pod).
		checks: z
			.object({
				scratchRoot: z.string().default("/tmp/kanban-checks"),
				timeoutMin: z.number().positive().default(15),
				// Packages whose install scripts npm may run in the checks install (npm 12 blocks them otherwise).
				allowScripts: z.array(z.string()).default(() => [...DEFAULT_CHECK_ALLOW_SCRIPTS]),
				maxWorkers: z.number().int().positive().default(2),
				niceness: z.number().int().min(0).max(19).default(10),
			})
			.strict()
			.default(() => ({
				scratchRoot: "/tmp/kanban-checks",
				timeoutMin: 15,
				allowScripts: [...DEFAULT_CHECK_ALLOW_SCRIPTS],
				maxWorkers: 2,
				niceness: 10,
			})),
		rework: z
			.object({
				// The hard cap: at this many FAIL rounds the core escalates whatever the kit says.
				maxFailRounds: z.number().int().positive().default(3),
				clearAfterTurns: z.number().int().positive().default(100),
				clearAfterTokens: z.number().int().positive().default(150_000),
			})
			.strict()
			.default({ maxFailRounds: 3, clearAfterTurns: 100, clearAfterTokens: 150_000 }),
		recovery: z
			.object({
				mode: recoveryModeSchema.default("report"),
				maxNudges: z.number().int().nonnegative().default(2),
				maxContinues: z.number().int().nonnegative().default(8),
				retryBackoffMin: z.array(z.number().positive()).default([1, 2, 4, 8]),
				hungMin: z.number().positive().default(15),
				hungFirstMin: z.number().positive().default(30),
				// Restart recovery resumes orphaned cards one at a time, this far apart.
				resumeGapSec: z.number().nonnegative().default(20),
				// After a nudge, how long the agent gets to pick it up before the card is decided on again.
				nudgeCheckSec: z.number().positive().default(120),
				outage: z
					.object({
						probeEveryMin: z.number().positive().default(5),
						upsToResume: z.number().int().positive().default(2),
						maxMin: z.number().positive().default(360),
					})
					.strict()
					.default({ probeEveryMin: 5, upsToResume: 2, maxMin: 360 }),
			})
			.strict()
			.default({
				mode: "report",
				maxNudges: 2,
				maxContinues: 8,
				retryBackoffMin: [1, 2, 4, 8],
				hungMin: 15,
				hungFirstMin: 30,
				resumeGapSec: 20,
				nudgeCheckSec: 120,
				outage: { probeEveryMin: 5, upsToResume: 2, maxMin: 360 },
			}),
	})
	.strict();

// What the watchdog (src/pipeline/watchdog/) does: "off" (default: the legacy kit's review-watch still runs on the
// pod), "report" (decide and log to data/<ws>/watchdog-decisions.jsonl, act on nothing: no ATTENTION.md, no wake, no
// input, no prune) or "on". The one-owner check in `kanban doctor` fails "on" while review-watch runs.
export const watchdogModeSchema = z.enum(["off", "report", "on"]);
export type WatchdogMode = z.infer<typeof watchdogModeSchema>;

const watchdogSectionSchema = z
	.object({
		mode: watchdogModeSchema.default("off"),
		intervalSec: z.number().positive().default(60),
		triageCards: z.boolean().default(false),
		triageCooldownMin: z.number().nonnegative().default(120),
		stall: z
			.object({
				reviewMin: z.number().positive().default(10),
				qaMin: z.number().positive().default(45),
				idleMin: z.number().positive().default(30),
				resumeIdleMin: z.number().positive().default(5),
				newCardGraceMin: z.number().nonnegative().default(10),
				promptMin: z.number().positive().default(3),
			})
			.strict()
			.default({ reviewMin: 10, qaMin: 45, idleMin: 30, resumeIdleMin: 5, newCardGraceMin: 10, promptMin: 3 }),
		pids: z
			.object({
				pressure: z.number().min(0).max(1).default(0.75),
				brownout: z.number().min(0).max(1).default(0.9),
			})
			.strict()
			.default({ pressure: 0.75, brownout: 0.9 }),
		pruneDone: z
			.object({ enabled: z.boolean().default(true), days: z.number().positive().default(3) })
			.strict()
			.default({ enabled: true, days: 3 }),
	})
	.strict();

// There is no `orchestrator.agent`: the orchestrator is always the agent selected in Kanban settings.
const orchestratorSectionSchema = z
	.object({
		wake: z
			.object({
				enabled: z.boolean().default(true),
				// "headless" falls back to "sidebar" when the selected agent has no headless runner.
				mode: z.enum(["headless", "sidebar"]).default("headless"),
				cooldownMin: z.number().nonnegative().default(30),
				timeoutMin: z.number().positive().default(45),
				liveSessionMin: z.number().nonnegative().default(10),
				// One workspace id whose sidebar gets the wakes of every workspace (one orchestrator); null = each
				// workspace wakes its own sidebar. Legacy kit `wakeTarget` (archive/devteam-kit:lib/sidebar-wake.cjs).
				target: z.string().min(1).nullable().default(null),
			})
			.strict()
			.default({
				enabled: true,
				mode: "headless",
				cooldownMin: 30,
				timeoutMin: 45,
				liveSessionMin: 10,
				target: null,
			}),
	})
	.strict();

const providerCapacitySchema = z.object({ maxLoadedModels: z.number().int().positive() }).strict();
const DEFAULT_PROVIDER_CAPACITY: Record<string, z.infer<typeof providerCapacitySchema>> = {
	lemonade: { maxLoadedModels: 1 },
};

const modelsSectionSchema = z
	.object({
		providers: z
			.object({
				default: z.string().default("bedrock"),
				// modelId → providerId, for models proven not to work on the default provider.
				fallback: z.record(z.string(), z.string()).default({}),
				deprecated: z.record(z.string(), z.string()).default({}),
			})
			.strict()
			.default({ default: "bedrock", fallback: {}, deprecated: {} }),
		// Provider id → capacity. A rework or start waits while another card holds a different model on a provider
		// at its limit (Lemonade loads one model at a time).
		// Merged over the defaults: setting one provider keeps Lemonade's limit.
		providerCapacity: z
			.record(z.string(), providerCapacitySchema)
			.default({})
			.transform((capacity) => ({ ...DEFAULT_PROVIDER_CAPACITY, ...capacity })),
		bedrockRegion: z.string().default("us-west-2"),
		lists: z
			.object({
				lemonade: z
					.object({
						url: z.string().default(DEFAULT_LEMONADE_MODEL_LIST_SETTINGS.url),
						requireLabels: z
							.array(z.string())
							.default(() => [...DEFAULT_LEMONADE_MODEL_LIST_SETTINGS.requireLabels]),
					})
					.strict()
					.default(() => structuredClone(DEFAULT_LEMONADE_MODEL_LIST_SETTINGS)),
			})
			.strict()
			.default(() => ({ lemonade: structuredClone(DEFAULT_LEMONADE_MODEL_LIST_SETTINGS) })),
	})
	.strict();

const DEFAULT_CLINE_TURN_DETECTOR = {
	mode: getDefaultClineTurnDetectorSettings().mode,
	intervalSec: getDefaultClineTurnDetectorSettings().intervalSec,
};

// The Cline CLI turn-end detector (cline-turn-detector-config.ts reads it on every tick).
const clineTurnDetectorSchema = z
	.object({
		mode: clineTurnDetectorModeSchema.default(DEFAULT_CLINE_TURN_DETECTOR.mode),
		intervalSec: z.number().int().positive().default(DEFAULT_CLINE_TURN_DETECTOR.intervalSec),
	})
	.strict();

// Agent data dirs: null = the agent's own default location.
const agentsSectionSchema = z
	.object({
		pretrust: z.boolean().default(true),
		cline: z
			.object({
				dataDir: z.string().nullable().default(null),
				turnDetector: clineTurnDetectorSchema.default(DEFAULT_CLINE_TURN_DETECTOR),
			})
			.strict()
			.default({ dataDir: null, turnDetector: DEFAULT_CLINE_TURN_DETECTOR }),
		codex: z
			.object({ home: z.string().nullable().default(null) })
			.strict()
			.default({ home: null }),
	})
	.strict();

const backupsSectionSchema = z
	.object({
		board: z
			.object({
				enabled: z.boolean().default(true),
				everyMin: z.number().positive().default(10),
				keep: z.number().int().positive().default(200),
			})
			.strict()
			.default({ enabled: true, everyMin: 10, keep: 200 }),
	})
	.strict();

/** Session sync is on by default in this fork (docs/fork/session-sync.md). */
export const DEFAULT_SESSION_SYNC_ENABLED = true;

// Whether the server moves cards between In Progress and Review (src/server/session-column-sync.ts), read once at
// server start. P2-1 shipped it as a top-level boolean (`"sessionSync": false`); that form still parses to the same
// value, so a config written for a P2-1 build keeps working, and `kanban doctor --fix` / `kanban config import-kit`
// rewrite it as `"sessionSync": { "enabled": false }` (isLegacySessionSyncValue).
//
// `reviewSettleSec` is the review settle rule's period (src/terminal/review-settle.ts): code that acts on a finished
// turn (QA snapshot and queue, auto-review's commit prompt, rework, recovery) waits until a card's session has been
// in Review this long with no new activity. It applies with session sync on or off, and is read at server start
// like `enabled`. 12 s: the longest resume seen is a Copilot turn that a background shell started about 6 s after
// the final agentStop (autopilot continuations come back within ~100 ms); twice that leaves room for a slower
// machine, and holding QA or a commit prompt back by 12 s costs nothing next to them. 0 turns the rule off.
export const DEFAULT_REVIEW_SETTLE_SEC = 12;
const sessionSyncObjectSchema = z
	.object({
		enabled: z.boolean().default(DEFAULT_SESSION_SYNC_ENABLED),
		reviewSettleSec: z.number().min(0).max(600).default(DEFAULT_REVIEW_SETTLE_SEC),
	})
	.strict();
export const sessionSyncSectionSchema = z.preprocess(
	(value) => (typeof value === "boolean" ? { enabled: value } : value),
	sessionSyncObjectSchema,
);

/** True for P2-1's top-level boolean form of `sessionSync`. */
export function isLegacySessionSyncValue(value: unknown): value is boolean {
	return typeof value === "boolean";
}

/**
 * config.json with the keys an older build wrote in an older form rewritten (today only P2-1's boolean
 * `sessionSync`). Returns the dotted keys it changed; an absent key stays absent (its default applies).
 * A build from before the move (P2-1 up to P3-2) reads the new `sessionSync` object as invalid and uses the
 * default (on), so after a rollback to one, `"sessionSync": { "enabled": false }` must be written back as `false`.
 */
export function migrateLegacyConfigKeys(config: Record<string, unknown>): {
	config: Record<string, unknown>;
	migrated: string[];
} {
	if (!isLegacySessionSyncValue(config.sessionSync)) {
		return { config, migrated: [] };
	}
	return { config: { ...config, sessionSync: { enabled: config.sessionSync } }, migrated: ["sessionSync"] };
}

/**
 * The commands a task card's agent must never run (src/guardrails/command-patterns.ts has the syntax): words match
 * the command's own words from the start, `a|b` is either word, `{shared}` is any shared branch (`guardrails.sharedBranches`
 * plus the card's base branch, also as `refs/heads/<name>`). Card-local rebases and resets stay allowed: a card's
 * worktree is on its own branch, and git refuses to check out a branch another worktree has.
 */
export const DEFAULT_GUARDRAIL_DENY_COMMANDS = [
	"git push",
	"git filter-branch",
	"git filter-repo",
	"git update-ref {shared}",
	"git update-ref -d {shared}",
	"git branch -D|-d|--delete|-f|--force|-m|-M {shared}",
	"git switch -C|--force-create {shared}",
	"git checkout -B {shared}",
	"podman restart|stop|rm|kill",
	"docker restart|stop|rm|kill",
	"systemctl restart|stop|kill",
	"systemctl --user restart|stop|kill",
	"kanban home migrate",
] as const;
const DEFAULT_GUARDRAIL_SHARED_BRANCHES = ["main", "master"] as const;

// Hard limits for task-card agents, translated by each agent adapter into its CLI's own deny mechanism
// (src/terminal/agent-guardrails.ts). The orchestrator (the home-agent sidebar session, its headless wakes) is
// exempt by design: it works in the project and all of its worktrees.
const guardrailsSectionSchema = z
	.object({
		enabled: z.boolean().default(true),
		// Keep card writes inside the card's worktree (plus temp dirs, its git dir and the agent's own data) where
		// the agent's CLI can enforce it.
		confineWrites: z.boolean().default(true),
		extraWritableDirs: z.array(z.string().min(1)).default([]),
		sharedBranches: z.array(z.string().min(1)).default(() => [...DEFAULT_GUARDRAIL_SHARED_BRANCHES]),
		denyCommands: z.array(z.string().min(1)).default(() => [...DEFAULT_GUARDRAIL_DENY_COMMANDS]),
	})
	.strict();
export type GuardrailsSettings = z.infer<typeof guardrailsSectionSchema>;

const SECTION_SCHEMAS = {
	sessionSync: sessionSyncSectionSchema,
	pipeline: pipelineSectionSchema,
	watchdog: watchdogSectionSchema,
	orchestrator: orchestratorSectionSchema,
	models: modelsSectionSchema,
	agents: agentsSectionSchema,
	backups: backupsSectionSchema,
	guardrails: guardrailsSectionSchema,
} as const;

type SectionName = keyof typeof SECTION_SCHEMAS;

export type PipelineConfig = { [Name in SectionName]: z.infer<(typeof SECTION_SCHEMAS)[Name]> } & {
	workspaces: Record<string, WorkspacePipelineSettings>;
};

export interface ParsedPipelineConfig {
	config: PipelineConfig;
	/** Sections or workspaces that didn't validate and fell back to their defaults. */
	issues: string[];
}

function readObjectKey(value: unknown, key: string): unknown {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function formatZodIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
		.join("; ");
}

/** The settings of a workspace without an entry: landing `off`, kit `default`. */
export function getDefaultWorkspacePipelineSettings(): WorkspacePipelineSettings {
	return workspacePipelineSettingsSchema.parse({});
}

export function parsePipelineConfig(raw: unknown): ParsedPipelineConfig {
	const issues: string[] = [];
	const sections: Partial<Record<SectionName, unknown>> = {};
	for (const name of Object.keys(SECTION_SCHEMAS) as SectionName[]) {
		const schema = SECTION_SCHEMAS[name];
		const parsed = schema.safeParse(readObjectKey(raw, name) ?? {});
		if (parsed.success) {
			sections[name] = parsed.data;
		} else {
			issues.push(`${name}: ${formatZodIssues(parsed.error)} (using the defaults for ${name}.*)`);
			sections[name] = schema.parse({});
		}
	}
	const workspaces: Record<string, WorkspacePipelineSettings> = {};
	const rawWorkspaces = readObjectKey(raw, "workspaces");
	if (
		rawWorkspaces !== undefined &&
		(typeof rawWorkspaces !== "object" || rawWorkspaces === null || Array.isArray(rawWorkspaces))
	) {
		issues.push("workspaces: expected an object keyed by workspace id (ignored)");
	} else {
		for (const [workspaceId, entry] of Object.entries((rawWorkspaces ?? {}) as Record<string, unknown>)) {
			const parsed = workspacePipelineSettingsSchema.safeParse(entry ?? {});
			if (parsed.success) {
				workspaces[workspaceId] = parsed.data;
			} else {
				// Falling back to the defaults means landing `off` on the `default` kit: the safe direction.
				issues.push(
					`workspaces.${workspaceId}: ${formatZodIssues(parsed.error)} (treated as landing off, kit default)`,
				);
				workspaces[workspaceId] = getDefaultWorkspacePipelineSettings();
			}
		}
	}
	return { config: { ...(sections as Omit<PipelineConfig, "workspaces">), workspaces }, issues };
}

/** A workspace's settings; a workspace without an entry gets the defaults (never another workspace's). */
export function getWorkspacePipelineSettings(config: PipelineConfig, workspaceId: string): WorkspacePipelineSettings {
	return config.workspaces[workspaceId] ?? getDefaultWorkspacePipelineSettings();
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function readConfigJson(configPath: string): Promise<Record<string, unknown>> {
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return {};
		}
		throw error;
	}
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${configPath} is not a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

/** config.json as it is on disk (`{}` when missing), for commands that change some keys and keep the rest. */
export async function readRawGlobalConfig(
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<Record<string, unknown>> {
	return await readConfigJson(configPath);
}

export async function readPipelineConfig(
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<ParsedPipelineConfig & { configPath: string }> {
	return { ...parsePipelineConfig(await readConfigJson(configPath)), configPath };
}

/**
 * Rewrites one workspace's raw entry in config.json under the config lock. Every other key is kept as it is in the
 * file (defaults are not written out). `update` gets the raw entry (or `{}`) and returns the new one, or null to
 * drop the entry. The result must validate, so a bad edit is refused before anything is written.
 */
export async function updateWorkspacePipelineEntry(
	workspaceId: string,
	update: (entry: Record<string, unknown>) => Record<string, unknown> | null,
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<WorkspacePipelineSettings> {
	let settings: WorkspacePipelineSettings | null = null;
	await updatePipelineConfigFile((config) => {
		const rawWorkspaces = readObjectKey(config, "workspaces");
		const workspaces =
			rawWorkspaces && typeof rawWorkspaces === "object" && !Array.isArray(rawWorkspaces)
				? { ...(rawWorkspaces as Record<string, unknown>) }
				: {};
		const current = readObjectKey(workspaces, workspaceId);
		const next = update(
			current && typeof current === "object" && !Array.isArray(current)
				? structuredClone(current as Record<string, unknown>)
				: {},
		);
		const parsed = workspacePipelineSettingsSchema.safeParse(next ?? {});
		if (!parsed.success) {
			throw new Error(`workspaces.${workspaceId}: ${formatZodIssues(parsed.error)}`);
		}
		settings = parsed.data;
		if (next === null) {
			delete workspaces[workspaceId];
		} else {
			workspaces[workspaceId] = next;
		}
		return { ...config, workspaces };
	}, configPath);
	return settings ?? getDefaultWorkspacePipelineSettings();
}

/**
 * Rewrites config.json under the config lock: `update` gets the raw file (or `{}`) and returns the new content.
 * Callers change only the keys they own, so every other key stays as it is in the file. The result must parse
 * without a pipeline-settings issue that the file didn't already have, so a bad edit is refused before writing.
 */
export async function updatePipelineConfigFile(
	update: (config: Record<string, unknown>) => Record<string, unknown>,
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<void> {
	await lockedFileSystem.withLock({ path: configPath, type: "file" }, async () => {
		const config = await readConfigJson(configPath);
		const before = new Set(parsePipelineConfig(config).issues);
		const payload = update(structuredClone(config));
		const added = parsePipelineConfig(payload).issues.filter((issue) => !before.has(issue));
		if (added.length > 0) {
			throw new Error(added.join("\n"));
		}
		if (shouldMarkKanbanHome()) {
			payload.home = KANBAN_HOME_MARKER_VERSION;
		}
		await lockedFileSystem.writeJsonFileAtomic(configPath, payload, { lock: null });
	});
}
