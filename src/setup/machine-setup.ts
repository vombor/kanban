// `kanban setup`'s machine steps. Each step first plans (reads only) and says what it would change; `apply` then
// writes. `kanban doctor` runs the same plans to report drift, so the two can't disagree. Every step only adds what
// is missing and never overwrites a value the user set. There is no bashrc step (nothing needs starting) and no
// Commit/PR prompt override (plan §2.5).
// Ported from archive/devteam-kit:bin/kit@d2fb30f `cmdMachineSetup` (npmrc, Cline rules, providers.json) and
// @c8552ae (Cline TUI notices). Kanban writes nothing under ~/.cline (user rule, 2026-10-07): the Cline rules and the
// notice opt-out now come with every Cline launch (agent-session-adapters.ts), and the providers and the two
// models.json (Lemonade) steps only check: the Lemonade ones print the `kanban cline apply-lemonade-models` line the
// user runs (user's choice, 2026-10-07), the providers one recommends AWS_BEARER_TOKEN_BEDROCK over a stored key and
// prints `kanban cline remove-bedrock-key` (2026-10-08).
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
import {
	BEDROCK_PODMAN_SECRET_LINE,
	CLINE_BEDROCK_KEY_ENV,
	describeClineBedrockKey,
	describeStoredBedrockKey,
	REMOVE_BEDROCK_KEY_COMMAND,
	readClineBedrockSettings,
} from "./cline-bedrock-key";
import { formatApplyLemonadeModelsHint } from "./cline-lemonade-apply";
import { isLemonadeModelsDiffEmpty, planClineLemonadeModels } from "./cline-lemonade-models";
import { buildLemonadeModelListUrl, planClineModelsSource } from "./cline-models-source";
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
	/** Present when status is `change`. Returns lines about what it wrote (backups included). Never set for a step
	 * on a file under ~/.cline: those are `manual` (Kanban writes nothing there). */
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
	/** Steps not to plan: doctor compares the Lemonade models in its own row (doctor/cline-models-checks.ts). */
	skipSteps?: readonly SetupStepId[];
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

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Whether Cline cards can reach Bedrock. Read-only: Kanban writes nothing under ~/.cline (user rule, 2026-10-07).
 * Cards pass `-P bedrock -m <model>`, and cline 3.0.69's Bedrock client takes the key and region from providers.json
 * (`settings.apiKey`, `settings.aws.region`), else from AWS_BEARER_TOKEN_BEDROCK (or AWS access keys) and AWS_REGION
 * in the environment Kanban, and so every card, starts from. The environment is the recommended source
 * (src/setup/cline-bedrock-key.ts): a stored key makes the step `manual` with `kanban cline remove-bedrock-key`.
 * When neither has a key this says what to run.
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
	const read = await readClineBedrockSettings(paths.clineProviders);
	if (read.kind === "invalid") {
		return { ...base, status: "error", details: [read.detail] };
	}
	const { env } = options;
	const facts = describeClineBedrockKey(read.kind === "found" ? read.settings : null, env);
	const keySource =
		facts.storedKey !== "none" && facts.withoutStoredKey !== "iam"
			? "providers.json"
			: facts.envKey
				? CLINE_BEDROCK_KEY_ENV
				: readNonEmptyString(env.AWS_ACCESS_KEY_ID)
					? "AWS_ACCESS_KEY_ID"
					: null;
	const missing: string[] = [];
	if (!keySource) {
		missing.push(
			`no Bedrock key for Cline: export ${CLINE_BEDROCK_KEY_ENV}${readNonEmptyString(env.BEDROCK_API_KEY) ? "=$BEDROCK_API_KEY" : ""} before starting Kanban (podman: ${BEDROCK_PODMAN_SECRET_LINE}); \`cline auth bedrock -k <key>\` works too, but stores it in plain text`,
		);
	}
	if (!facts.region) {
		missing.push(`no Bedrock region for Cline: export AWS_REGION=${options.bedrockRegion} before starting Kanban`);
	}
	const stored = describeStoredBedrockKey(facts, paths.clineProviders);
	if (stored && facts.withoutStoredKey === "env") {
		missing.push(`${stored}: run \`${REMOVE_BEDROCK_KEY_COMMAND}\``);
	}
	if (missing.length > 0) {
		return { ...base, status: "manual", details: missing };
	}
	return { ...base, status: "ok", details: [`bedrock key from ${keySource}, region ${facts.region}`] };
}

/**
 * Lemonade `modelsSourceUrl` in Cline's models.json. Read-only: when it should change the step is `manual` and says
 * which command the user runs (Kanban writes nothing under ~/.cline).
 */
export async function planClineModelsSourceStep(paths: MachineSetupPaths, origin: string): Promise<SetupStepPlan> {
	const targetUrl = buildLemonadeModelListUrl(origin);
	const plan = await planClineModelsSource(paths.clineModels, targetUrl);
	const current = plan.currentUrl ?? "(none)";
	const base = { id: "cline-models-source" as const, target: paths.clineModels };
	switch (plan.action) {
		case "update":
			return {
				...base,
				status: "manual",
				details: [`lemonade modelsSourceUrl: ${current} -> ${targetUrl}`, formatApplyLemonadeModelsHint(origin)],
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

/**
 * Lemonade per-model metadata in Cline's models.json, compared with what Lemonade reports now. Read-only, like the
 * step above: differences make it `manual` with the command to run.
 */
export async function planClineLemonadeModelsStep(
	paths: MachineSetupPaths,
	options: { origin: string; lemonadeModelList: LemonadeModelListSettings; fetch?: typeof fetch },
): Promise<SetupStepPlan> {
	const plan = await planClineLemonadeModels({
		modelsPath: paths.clineModels,
		requireLabels: options.lemonadeModelList.requireLabels,
		lemonadeUrl: options.lemonadeModelList.url,
		fetch: options.fetch,
	});
	const base = { id: "cline-lemonade-models" as const, target: paths.clineModels };
	if (plan.kind !== "found") {
		return { ...base, status: plan.kind === "absent" ? "skipped" : "error", details: plan.details };
	}
	if (!isLemonadeModelsDiffEmpty(plan.diff)) {
		return { ...base, status: "manual", details: [...plan.details, formatApplyLemonadeModelsHint(options.origin)] };
	}
	// Lemonade down is not a setup failure: nothing can be compared, and the next run does.
	return { ...base, status: plan.inSync ? "ok" : "skipped", details: plan.details };
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
					origin: options.origin,
					lemonadeModelList: options.lemonadeModelList ?? (await readLemonadeModelListSettings()).settings,
					fetch: options.fetch,
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
		if (options.skipSteps?.includes(step.id)) {
			continue;
		}
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
