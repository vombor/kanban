// `kanban setup`'s machine steps. Each step first plans (reads only) and says what it would change; `apply` then
// writes. `kanban doctor` runs the same plans to report drift, so the two can't disagree. Every step only adds what
// is missing and never overwrites a value the user set. There is no bashrc step (nothing needs starting) and no
// Commit/PR prompt override (plan §2.5).
// Ported from archive/devteam-kit:bin/kit@d2fb30f `cmdMachineSetup` (npmrc, Cline rules, providers.json) and
// @c8552ae (Cline TUI notices).
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { PipelineConfig } from "../config/pipeline-config";
import {
	getClineCliNoticesPath,
	getClineGlobalRulesPath,
	getClineModelsSettingsPath,
	getClineProvidersSettingsPath,
} from "../state/kanban-home";
import {
	CLAUDE_MD_SECTION,
	getClaudeConfigDirPath,
	getClaudeUserMemoryPath,
	renderClaudeMdSection,
} from "./claude-md-section";
import { applyClineModelsSource, buildLemonadeModelListUrl, planClineModelsSource } from "./cline-models-source";
import { CLINE_RULE_FILES } from "./cline-rules";
import { readManagedSectionStatus, writeManagedSection } from "./managed-section";

export type SetupStepId =
	| "npmrc"
	| "cline-rules"
	| "cline-notices"
	| "cline-providers"
	| "cline-models-source"
	| "claude-md";

/** `ok`: nothing to do. `change`: `apply` would write. `skipped`: not applicable here. `error`: can't be planned. */
export type SetupStepStatus = "ok" | "change" | "skipped" | "error";

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
	/** Overwrite Cline rule files that differ from Kanban's copy. */
	forceRules?: boolean;
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
}

export interface MachineSetupPaths {
	npmrc: string;
	clineRulesDir: string;
	clineNotices: string;
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
		clineRulesDir: getClineGlobalRulesPath(),
		clineNotices: getClineCliNoticesPath(clineDataDir),
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

function backupTimestamp(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d+Z$/u, "Z");
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

export async function planClineRules(paths: MachineSetupPaths, forceRules: boolean): Promise<SetupStepPlan> {
	const details: string[] = [];
	const toWrite: string[] = [];
	for (const [name, content] of Object.entries(CLINE_RULE_FILES)) {
		const current = await readTextOrNull(join(paths.clineRulesDir, name));
		if (current === content) {
			continue;
		}
		if (current === null) {
			details.push(`install ${name}`);
			toWrite.push(name);
		} else if (forceRules) {
			details.push(`overwrite ${name} (--force-rules)`);
			toWrite.push(name);
		} else {
			details.push(`${name} differs from Kanban's copy; left alone (--force-rules overwrites)`);
		}
	}
	if (toWrite.length === 0) {
		return {
			id: "cline-rules",
			target: paths.clineRulesDir,
			status: "ok",
			details: details.length > 0 ? details : [`${Object.keys(CLINE_RULE_FILES).length} rules installed`],
		};
	}
	return {
		id: "cline-rules",
		target: paths.clineRulesDir,
		status: "change",
		details,
		apply: async () => {
			await mkdir(paths.clineRulesDir, { recursive: true });
			for (const name of toWrite) {
				await writeFile(join(paths.clineRulesDir, name), CLINE_RULE_FILES[name] ?? "");
			}
			return [`wrote ${toWrite.join(", ")}`];
		},
	};
}

// cline 3.x shows each promo notice on every task open until its id is marked shown, and the notice covers the TUI
// the card agent types into. Ported from archive/devteam-kit:bin/kit@c8552ae.
const CLINE_NOTICE_IDS = ["cline-cli-cline-pass-intro", "cline-cli-desktop-launch"];

export async function planClineNotices(paths: MachineSetupPaths): Promise<SetupStepPlan> {
	const text = await readTextOrNull(paths.clineNotices);
	let notices: Record<string, unknown> = {};
	if (text !== null) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				notices = parsed as Record<string, unknown>;
			}
		} catch {
			return {
				id: "cline-notices",
				target: paths.clineNotices,
				status: "error",
				details: ["not valid JSON; left alone"],
			};
		}
	}
	const shown =
		notices.shown && typeof notices.shown === "object" && !Array.isArray(notices.shown)
			? (notices.shown as Record<string, unknown>)
			: {};
	const unshown = CLINE_NOTICE_IDS.filter((id) => shown[id] !== true);
	if (unshown.length === 0) {
		return { id: "cline-notices", target: paths.clineNotices, status: "ok", details: ["promo notices marked shown"] };
	}
	return {
		id: "cline-notices",
		target: paths.clineNotices,
		status: "change",
		details: [`mark shown: ${unshown.join(", ")}`],
		apply: async () => {
			const next = { ...notices, shown: { ...shown, ...Object.fromEntries(unshown.map((id) => [id, true])) } };
			await writeFileKeepingMode(paths.clineNotices, `${JSON.stringify(next, null, 2)}\n`);
			return [`marked shown: ${unshown.join(", ")}`];
		},
	};
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Adds keys of `source` missing in `target` (recursively); returns the dotted keys it added. Never overwrites. */
function addMissingKeys(target: JsonObject, source: JsonObject, prefix: string): string[] {
	const added: string[] = [];
	for (const [key, value] of Object.entries(source)) {
		const current = target[key];
		if (current === undefined) {
			target[key] = structuredClone(value);
			added.push(`${prefix}${key}`);
		} else if (isJsonObject(value) && isJsonObject(current)) {
			added.push(...addMissingKeys(current, value, `${prefix}${key}.`));
		}
	}
	return added;
}

/** The provider entries Kanban adds to Cline's providers.json. No secrets: the key comes from the environment. */
function buildClineProviderTemplate(bedrockRegion: string): Record<string, JsonObject> {
	return {
		bedrock: {
			settings: {
				provider: "bedrock",
				model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
				aws: { region: bedrockRegion },
			},
		},
	};
}

interface ProvidersPlanResult {
	document: JsonObject;
	added: string[];
	notes: string[];
}

function planProviderEntries(
	document: JsonObject,
	template: Record<string, JsonObject>,
	env: NodeJS.ProcessEnv,
	now: Date,
): ProvidersPlanResult {
	const next = structuredClone(document);
	if (!isJsonObject(next.providers)) {
		next.providers = {};
	}
	const providers = next.providers as JsonObject;
	const envKey = env.BEDROCK_API_KEY?.trim() || null;
	const existingKey =
		Object.values(providers)
			.map((entry) => (isJsonObject(entry) && isJsonObject(entry.settings) ? entry.settings.apiKey : undefined))
			.find((key): key is string => typeof key === "string" && key.length > 0) ?? null;
	const added: string[] = [];
	const notes: string[] = [];
	for (const [name, entry] of Object.entries(template)) {
		const current = isJsonObject(providers[name]) ? (providers[name] as JsonObject) : {};
		providers[name] = current;
		added.push(...addMissingKeys(current, entry, `${name}.`));
		if (!isJsonObject(current.settings)) {
			current.settings = {};
		}
		const settings = current.settings as JsonObject;
		if (!settings.apiKey) {
			const key = envKey ?? existingKey;
			if (key) {
				// The key's value is never printed, only where it came from.
				settings.apiKey = key;
				current.tokenSource ??= "manual";
				added.push(`${name}.settings.apiKey (from ${envKey ? "BEDROCK_API_KEY" : "another provider entry"})`);
			} else {
				notes.push(`${name} has no apiKey; set BEDROCK_API_KEY and run kanban setup again`);
			}
		}
		if (current.updatedAt === undefined) {
			current.updatedAt = now.toISOString();
		}
	}
	return { document: next, added, notes };
}

export async function planClineProviders(
	paths: MachineSetupPaths,
	options: { bedrockRegion: string; defaultProvider: string; env: NodeJS.ProcessEnv; now: Date },
): Promise<SetupStepPlan> {
	if (options.defaultProvider !== "bedrock") {
		return {
			id: "cline-providers",
			target: paths.clineProviders,
			status: "skipped",
			details: [`models.providers.default is ${options.defaultProvider}; Kanban only ships a bedrock entry`],
		};
	}
	const raw = await readTextOrNull(paths.clineProviders);
	if (raw === null) {
		// Cline writes this file when it is first configured; a machine without it doesn't run Cline yet.
		return {
			id: "cline-providers",
			target: paths.clineProviders,
			status: "skipped",
			details: ["no providers.json (Cline is not configured on this machine)"],
		};
	}
	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch {
		return {
			id: "cline-providers",
			target: paths.clineProviders,
			status: "error",
			details: ["not valid JSON; left alone"],
		};
	}
	if (!isJsonObject(document)) {
		return {
			id: "cline-providers",
			target: paths.clineProviders,
			status: "error",
			details: ["not a JSON object; left alone"],
		};
	}
	const plan = planProviderEntries(
		document,
		buildClineProviderTemplate(options.bedrockRegion),
		options.env,
		options.now,
	);
	if (plan.added.length === 0) {
		return {
			id: "cline-providers",
			target: paths.clineProviders,
			status: "ok",
			details: plan.notes.length > 0 ? plan.notes : ["provider entries present"],
		};
	}
	return {
		id: "cline-providers",
		target: paths.clineProviders,
		status: "change",
		details: [`add ${plan.added.join(", ")} (existing values are kept)`, ...plan.notes],
		apply: async () => {
			// The file holds API keys: the backup sits next to it with the same mode, never in a repo.
			const mode = (await stat(paths.clineProviders)).mode & 0o7777;
			const backupPath = `${paths.clineProviders}.bak-before-kanban-setup-${backupTimestamp(options.now)}`;
			await writeFile(backupPath, raw, { encoding: "utf8", mode, flag: "wx" });
			await chmod(backupPath, mode);
			await writeFileKeepingMode(paths.clineProviders, `${JSON.stringify(plan.document, null, 2)}\n`);
			return [`added ${plan.added.join(", ")}`, `backup: ${backupPath}`];
		},
	};
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
			id: "cline-rules",
			target: paths.clineRulesDir,
			plan: () => planClineRules(paths, options.forceRules === true),
		},
		{ id: "cline-notices", target: paths.clineNotices, plan: () => planClineNotices(paths) },
		{
			id: "cline-providers",
			target: paths.clineProviders,
			plan: () =>
				planClineProviders(paths, {
					bedrockRegion: options.config.models.bedrockRegion,
					defaultProvider: options.config.models.providers.default,
					env,
					now,
				}),
		},
		{
			id: "cline-models-source",
			target: paths.clineModels,
			plan: () => planClineModelsSourceStep(paths, options.origin),
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
