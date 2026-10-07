// `kanban setup`'s machine steps. Each step first plans (reads only) and says what it would change; `apply` then
// writes. `kanban doctor` runs the same plans to report drift, so the two can't disagree. Every step only adds what
// is missing and never overwrites a value the user set. There is no bashrc step (nothing needs starting) and no
// Commit/PR prompt override (plan §2.5).
// Ported from archive/devteam-kit:bin/kit@d2fb30f `cmdMachineSetup` (npmrc, Cline rules, providers.json) and
// @c8552ae (Cline TUI notices). Kanban writes nothing under ~/.cline (user rule, 2026-10-07): the Cline rules and the
// notice opt-out now come with every Cline launch (agent-session-adapters.ts), and the providers step only checks.
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type LemonadeModelListSettings, readLemonadeModelListSettings } from "../config/model-lists-config";
import type { PipelineConfig } from "../config/pipeline-config";
import { getClineModelsSettingsPath, getClineProvidersSettingsPath } from "../state/kanban-home";
import {
	CLAUDE_MD_SECTION,
	getClaudeConfigDirPath,
	getClaudeUserMemoryPath,
	renderClaudeMdSection,
} from "./claude-md-section";
import { planClineLemonadeModels } from "./cline-lemonade-models";
import { applyClineModelsSource, buildLemonadeModelListUrl, planClineModelsSource } from "./cline-models-source";
import { readManagedSectionStatus, writeManagedSection } from "./managed-section";

export type SetupStepId = "npmrc" | "cline-providers" | "cline-models-source" | "cline-lemonade-models" | "claude-md";

/**
 * `ok`: nothing to do. `change`: `apply` would write. `manual`: something to do that Kanban doesn't write (the
 * details say what to run). `skipped`: not applicable here. `error`: can't be planned.
 */
export type SetupStepStatus = "ok" | "change" | "manual" | "skipped" | "error";

export interface SetupStepPlan {
	id: SetupStepId;
	target: string;
	status: SetupStepStatus;
	/** What is ok, what would change, or why the step is skipped. */
	details: string[];
	/** Present when status is `change`. Returns lines about what it wrote (backups included). */
	apply?: () => Promise<string[]>;
}

export interface MachineSetupOptions {
	/** Kanban server origin for Cline's Lemonade model list. */
	origin: string;
	/** Write the CLAUDE.md section even while the legacy kit is installed. */
	forceClaudeMd?: boolean;
	/** The legacy kit is installed (its kit.config.json exists). */
	legacyKitInstalled: boolean;
	/** Core settings: `models.providers.default`, `models.bedrockRegion`, `agents.cline.dataDir`. */
	config: PipelineConfig;
	env?: NodeJS.ProcessEnv;
	now?: Date;
	/** Test hooks: file locations. */
	paths?: Partial<MachineSetupPaths>;
	/** Test hook: `models.lists.lemonade` (default: read from the global config.json). */
	lemonadeModelList?: LemonadeModelListSettings;
	/** Test hook: the fetch that asks Lemonade for its models. */
	fetch?: typeof fetch;
}

export interface MachineSetupPaths {
	npmrc: string;
	clineProviders: string;
	clineModels: string;
	claudeDir: string;
	claudeMd: string;
}

export function getMachineSetupPaths(
	env: NodeJS.ProcessEnv = process.env,
	clineDataDir: string | null = null,
): MachineSetupPaths {
	return {
		npmrc: env.NPM_CONFIG_USERCONFIG?.trim() || join(homedir(), ".npmrc"),
		clineProviders: getClineProvidersSettingsPath(clineDataDir),
		clineModels: getClineModelsSettingsPath(clineDataDir),
		claudeDir: getClaudeConfigDirPath(env),
		claudeMd: getClaudeUserMemoryPath(env),
	};
}

async function readTextOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Replaces `path` atomically with `content`, keeping its mode (new files get `newMode`). */
async function writeFileKeepingMode(path: string, content: string, newMode = 0o644): Promise<void> {
	let mode = newMode;
	try {
		mode = (await stat(path)).mode & 0o7777;
	} catch {
		await mkdir(dirname(path), { recursive: true });
	}
	const tempPath = `${path}.tmp.${process.pid}.${Date.now()}`;
	await writeFile(tempPath, content, { encoding: "utf8", mode });
	await chmod(tempPath, mode);
	await rename(tempPath, path);
}

// Quiet npm (user request 2026-10-05): hide "npm notice" lines and npm run banners; warnings and errors still show.
const NPMRC_SETTINGS: ReadonlyArray<readonly [string, string]> = [
	["loglevel", "warn"],
	["update-notifier", "false"],
	["fund", "false"],
];

export async function planNpmrc(paths: MachineSetupPaths): Promise<SetupStepPlan> {
	const text = (await readTextOrNull(paths.npmrc)) ?? "";
	const keys = new Set(
		text
			.split("\n")
			.map((line) => /^\s*([\w-]+)\s*=/u.exec(line)?.[1])
			.filter((key): key is string => Boolean(key)),
	);
	const missing = NPMRC_SETTINGS.filter(([key]) => !keys.has(key)).map(([key, value]) => `${key}=${value}`);
	if (missing.length === 0) {
		return { id: "npmrc", target: paths.npmrc, status: "ok", details: ["quiet npm settings present"] };
	}
	return {
		id: "npmrc",
		target: paths.npmrc,
		status: "change",
		details: [`add ${missing.join(", ")} (existing settings are kept)`],
		apply: async () => {
			const current = (await readTextOrNull(paths.npmrc)) ?? "";
			const separator = current && !current.endsWith("\n") ? "\n" : "";
			await writeFileKeepingMode(
				paths.npmrc,
				`${current}${separator}# kanban setup: quiet npm\n${missing.join("\n")}\n`,
			);
			return [`added ${missing.join(", ")}`];
		},
	};
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Whether Cline cards can reach Bedrock. Read-only: Kanban writes nothing under ~/.cline (user rule, 2026-10-07).
 * Cards pass `-P bedrock -m <model>`, and cline 3.0.69's Bedrock client takes the key and region from providers.json
 * (`settings.apiKey`, `settings.aws.region`), else from AWS_BEARER_TOKEN_BEDROCK (or AWS access keys) and AWS_REGION
 * in the environment Kanban, and so every card, starts from. When neither has them this says what to run.
 */
export async function planClineProviders(
	paths: MachineSetupPaths,
	options: { bedrockRegion: string; defaultProvider: string; env: NodeJS.ProcessEnv },
): Promise<SetupStepPlan> {
	const base = { id: "cline-providers" as const, target: paths.clineProviders };
	if (options.defaultProvider !== "bedrock") {
		return {
			...base,
			status: "skipped",
			details: [`models.providers.default is ${options.defaultProvider}; Kanban only checks bedrock`],
		};
	}
	const raw = await readTextOrNull(paths.clineProviders);
	let settings: JsonObject = {};
	if (raw !== null) {
		let document: unknown;
		try {
			document = JSON.parse(raw);
		} catch {
			return { ...base, status: "error", details: ["not valid JSON (Kanban never edits it)"] };
		}
		const entry = isJsonObject(document) && isJsonObject(document.providers) ? document.providers.bedrock : null;
		settings = isJsonObject(entry) && isJsonObject(entry.settings) ? entry.settings : {};
	}
	const { env } = options;
	const keySource = readNonEmptyString(settings.apiKey)
		? "providers.json"
		: readNonEmptyString(env.AWS_BEARER_TOKEN_BEDROCK)
			? "AWS_BEARER_TOKEN_BEDROCK"
			: readNonEmptyString(env.AWS_ACCESS_KEY_ID)
				? "AWS_ACCESS_KEY_ID"
				: null;
	const region =
		readNonEmptyString(isJsonObject(settings.aws) ? settings.aws.region : undefined) ??
		readNonEmptyString(env.AWS_REGION);
	const missing: string[] = [];
	if (!keySource) {
		missing.push(
			readNonEmptyString(env.BEDROCK_API_KEY)
				? "no Bedrock key for Cline: export AWS_BEARER_TOKEN_BEDROCK=$BEDROCK_API_KEY before starting Kanban, or run `cline auth bedrock -k <key>`"
				: "no Bedrock key for Cline: export AWS_BEARER_TOKEN_BEDROCK before starting Kanban, or run `cline auth bedrock -k <key>`",
		);
	}
	if (!region) {
		missing.push(`no Bedrock region for Cline: export AWS_REGION=${options.bedrockRegion} before starting Kanban`);
	}
	if (missing.length > 0) {
		return { ...base, status: "manual", details: missing };
	}
	return { ...base, status: "ok", details: [`bedrock key from ${keySource}, region ${region}`] };
}

export async function planClineModelsSourceStep(paths: MachineSetupPaths, origin: string): Promise<SetupStepPlan> {
	const targetUrl = buildLemonadeModelListUrl(origin);
	const plan = await planClineModelsSource(paths.clineModels, targetUrl);
	const current = plan.currentUrl ?? "(none)";
	const base = { id: "cline-models-source" as const, target: paths.clineModels };
	switch (plan.action) {
		case "update":
			return {
				...base,
				status: "change",
				details: [`lemonade modelsSourceUrl: ${current} -> ${targetUrl}`],
				apply: async () => {
					const result = await applyClineModelsSource({ modelsPath: paths.clineModels, targetUrl, dryRun: false });
					return [
						`lemonade modelsSourceUrl: ${current} -> ${targetUrl}`,
						...(result.backupPath ? [`backup: ${result.backupPath}`] : []),
					];
				},
			};
		case "up-to-date":
			return { ...base, status: "ok", details: [`lemonade modelsSourceUrl: ${current}`] };
		case "custom":
			return { ...base, status: "ok", details: [`lemonade modelsSourceUrl: ${current} (${plan.detail})`] };
		case "error":
			return { ...base, status: "error", details: [plan.detail] };
		default:
			return { ...base, status: "skipped", details: [plan.detail] };
	}
}

export async function planClineLemonadeModelsStep(
	paths: MachineSetupPaths,
	options: { lemonadeModelList: LemonadeModelListSettings; fetch?: typeof fetch; now: Date },
): Promise<SetupStepPlan> {
	const plan = await planClineLemonadeModels({
		modelsPath: paths.clineModels,
		requireLabels: options.lemonadeModelList.requireLabels,
		lemonadeUrl: options.lemonadeModelList.url,
		fetch: options.fetch,
		now: options.now,
	});
	const base = { id: "cline-lemonade-models" as const, target: paths.clineModels, details: plan.details };
	switch (plan.action) {
		case "update":
			return { ...base, status: "change", apply: plan.apply };
		case "up-to-date":
			return { ...base, status: "ok" };
		case "error":
			return { ...base, status: "error" };
		default:
			// Lemonade down is not a setup failure: the file keeps its values and the next run fills them in.
			return { ...base, status: "skipped" };
	}
}

export async function planClaudeMd(
	paths: MachineSetupPaths,
	options: { legacyKitInstalled: boolean; force: boolean },
): Promise<SetupStepPlan> {
	const base = { id: "claude-md" as const, target: paths.claudeMd };
	if (!(await pathExists(paths.claudeDir))) {
		return { ...base, status: "skipped", details: ["Claude Code is not set up on this machine"] };
	}
	const status = await readManagedSectionStatus(CLAUDE_MD_SECTION, paths.claudeMd, renderClaudeMdSection());
	if (status.state === "current") {
		return { ...base, status: "ok", details: ["kanban section is current"] };
	}
	if (options.legacyKitInstalled && !options.force && status.state !== "outdated") {
		return {
			...base,
			status: "skipped",
			details: [
				"the legacy kit's instructions are in this file until cutover; --claude-md writes the kanban section anyway",
			],
		};
	}
	const action =
		status.state === "outdated" || status.state === "legacy"
			? "update the kanban section"
			: "add the kanban section (your text outside the markers is kept)";
	return {
		...base,
		status: "change",
		details: [action],
		apply: async () => {
			await mkdir(dirname(paths.claudeMd), { recursive: true });
			await writeManagedSection(CLAUDE_MD_SECTION, status);
			return [action];
		},
	};
}

export async function planMachineSetup(options: MachineSetupOptions): Promise<SetupStepPlan[]> {
	const env = options.env ?? process.env;
	const now = options.now ?? new Date();
	const paths = { ...getMachineSetupPaths(env, options.config.agents.cline.dataDir), ...options.paths };
	const steps: Array<{ id: SetupStepId; target: string; plan: () => Promise<SetupStepPlan> }> = [
		{ id: "npmrc", target: paths.npmrc, plan: () => planNpmrc(paths) },
		{
			id: "cline-providers",
			target: paths.clineProviders,
			plan: () =>
				planClineProviders(paths, {
					bedrockRegion: options.config.models.bedrockRegion,
					defaultProvider: options.config.models.providers.default,
					env,
				}),
		},
		{
			id: "cline-models-source",
			target: paths.clineModels,
			plan: () => planClineModelsSourceStep(paths, options.origin),
		},
		{
			id: "cline-lemonade-models",
			target: paths.clineModels,
			plan: async () =>
				planClineLemonadeModelsStep(paths, {
					lemonadeModelList: options.lemonadeModelList ?? (await readLemonadeModelListSettings()).settings,
					fetch: options.fetch,
					now,
				}),
		},
		{
			id: "claude-md",
			target: paths.claudeMd,
			plan: () =>
				planClaudeMd(paths, {
					legacyKitInstalled: options.legacyKitInstalled,
					force: options.forceClaudeMd === true,
				}),
		},
	];
	const plans: SetupStepPlan[] = [];
	for (const step of steps) {
		try {
			plans.push(await step.plan());
		} catch (error) {
			plans.push({
				id: step.id,
				target: step.target,
				status: "error",
				details: [error instanceof Error ? error.message : String(error)],
			});
		}
	}
	return plans;
}
