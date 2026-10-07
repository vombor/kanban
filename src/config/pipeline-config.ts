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

import { lockedFileSystem } from "../fs/locked-file-system";
import { getKanbanGlobalConfigPath, KANBAN_HOME_MARKER_VERSION, shouldMarkKanbanHome } from "../state/kanban-home";
import { DEFAULT_LEMONADE_MODEL_LIST_SETTINGS } from "./model-lists-config";

export const landingModeSchema = z.enum(["off", "commit", "pr", "qa"]);
export type LandingMode = z.infer<typeof landingModeSchema>;

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
	})
	.strict();
export type WorkspacePipelineSettings = z.infer<typeof workspacePipelineSettingsSchema>;

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
			}),
		checks: z
			.object({
				scratchRoot: z.string().default("/tmp/kanban-checks"),
				timeoutMin: z.number().positive().default(15),
				allowScripts: z.boolean().default(false),
			})
			.strict()
			.default({ scratchRoot: "/tmp/kanban-checks", timeoutMin: 15, allowScripts: false }),
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
				maxNudges: z.number().int().nonnegative().default(2),
				maxContinues: z.number().int().nonnegative().default(8),
				retryBackoffMin: z.array(z.number().positive()).default([1, 2, 4, 8]),
				hungMin: z.number().positive().default(15),
				hungFirstMin: z.number().positive().default(30),
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
				maxNudges: 2,
				maxContinues: 8,
				retryBackoffMin: [1, 2, 4, 8],
				hungMin: 15,
				hungFirstMin: 30,
				outage: { probeEveryMin: 5, upsToResume: 2, maxMin: 360 },
			}),
	})
	.strict();

const watchdogSectionSchema = z
	.object({
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
			})
			.strict()
			.default({ enabled: true, mode: "headless", cooldownMin: 30, timeoutMin: 45, liveSessionMin: 10 }),
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

// Agent data dirs: null = the agent's own default location.
const agentsSectionSchema = z
	.object({
		pretrust: z.boolean().default(true),
		cline: z
			.object({ dataDir: z.string().nullable().default(null) })
			.strict()
			.default({ dataDir: null }),
		codex: z
			.object({ home: z.string().nullable().default(null) })
			.strict()
			.default({ home: null }),
	})
	.strict();

const backupsSectionSchema = z
	.object({
		board: z
			.object({ everyMin: z.number().positive().default(10), keep: z.number().int().positive().default(200) })
			.strict()
			.default({ everyMin: 10, keep: 200 }),
	})
	.strict();

const SECTION_SCHEMAS = {
	pipeline: pipelineSectionSchema,
	watchdog: watchdogSectionSchema,
	orchestrator: orchestratorSectionSchema,
	models: modelsSectionSchema,
	agents: agentsSectionSchema,
	backups: backupsSectionSchema,
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
	return await lockedFileSystem.withLock({ path: configPath, type: "file" }, async () => {
		const config = await readConfigJson(configPath);
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
		if (next === null) {
			delete workspaces[workspaceId];
		} else {
			workspaces[workspaceId] = next;
		}
		const payload: Record<string, unknown> = { ...config, workspaces };
		if (shouldMarkKanbanHome()) {
			payload.home = KANBAN_HOME_MARKER_VERSION;
		}
		await lockedFileSystem.writeJsonFileAtomic(configPath, payload, { lock: null });
		return parsed.data;
	});
}
