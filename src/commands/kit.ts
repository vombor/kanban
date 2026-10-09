import type { Command } from "commander";
import { readLemonadeModelListSettings } from "../config/model-lists-config";
import {
	getWorkspacePipelineSettings,
	type LandingMode,
	landingModeSchema,
	type PipelineConfig,
	readPipelineConfig,
} from "../config/pipeline-config";
import { loadGlobalRuntimeConfig } from "../config/runtime-config";
import { type ApplyKitResult, applyWorkspaceKit } from "../kits/apply-kit";
import { buildKitReport, formatKitReport, formatRecommendedSettings, NO_WORKSPACE_ID } from "../kits/kit-report";
import type { KitDocument } from "../kits/kit-schema";
import {
	assessLocalResidency,
	LEMONADE_PROVIDER,
	type LocalResidencyFinding,
	listKitLocalWorkingSet,
} from "../kits/local-residency";
import { migrateWorkspaceOverrides, type OverrideMigrationPlan } from "../kits/migrate-overrides";
import { describeProjectSettings, readKitSettingsHistory } from "../kits/project-settings";
import { loadKitCatalog, resolveKitByName, resolveWorkspaceKit } from "../kits/resolve-kit";
import { fetchLemonadeMaxLoadedLlms, lemonadeApiBaseUrl } from "../models/lemonade-models";
import { getKanbanKitsPath, getKitSettingsHistoryPath } from "../state/kanban-home";
import type { KitSettingChangeResponse } from "../trpc/kit-settings-api";
import { createRuntimeTrpcClient } from "./runtime-trpc-client";
import { resolveWorkspaceTarget } from "./workspace-target";

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printLines(lines: string[]): void {
	process.stdout.write(`${lines.join("\n")}\n`);
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/** A value on the command line: JSON when it is JSON (`true`, `3`, `null`, `["a"]`, `"text"`), else the text itself. */
export function parseKitSettingValue(rawValue: string): unknown {
	try {
		return JSON.parse(rawValue);
	} catch {
		return rawValue;
	}
}

/** `key=value`: the value is parsed as JSON when it is JSON (`true`, `3`, `["a"]`, `"text"`), else kept as text. */
export function parseSetAssignments(assignments: string[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const assignment of assignments) {
		const separator = assignment.indexOf("=");
		if (separator <= 0) {
			throw new Error(`--set ${assignment}: expected key=value.`);
		}
		const key = assignment.slice(0, separator).trim();
		result[key] = parseKitSettingValue(assignment.slice(separator + 1));
	}
	return result;
}

export function parseLandingMode(value: string | undefined): LandingMode | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed = landingModeSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`--landing ${value}: expected one of ${landingModeSchema.options.join(", ")}.`);
	}
	return parsed.data;
}

function formatApplyResult(result: ApplyKitResult, dryRun: boolean): string[] {
	const lines = [`Workspace ${result.workspaceId}: kit ${result.kitName.from} -> ${result.kitName.to}`];
	lines.push(
		result.landing.from === result.landing.to
			? `Landing mode: ${result.landing.to} (unchanged)`
			: `Landing mode: ${result.landing.from} -> ${result.landing.to}`,
	);
	for (const issue of result.previousIssues) {
		lines.push(`Before: ${issue}`);
	}
	if (result.changes.length === 0) {
		lines.push("No resolved value changes.");
	} else {
		lines.push("Changes (key: old [source] -> new [source]):");
		for (const change of result.changes) {
			lines.push(
				`  ${change.key}: ${JSON.stringify(change.from) ?? "(none)"} [${change.fromSource ?? "-"}] -> ${JSON.stringify(change.to) ?? "(none)"} [${change.toSource ?? "-"}]`,
			);
		}
	}
	if (result.recommendedLandingMode && result.recommendedLandingMode !== result.landing.to) {
		lines.push(
			`Kit ${result.kitName.to} recommends landing mode "${result.recommendedLandingMode}"; it is not applied without --landing ${result.recommendedLandingMode}.`,
		);
	}
	if (result.unmetSettings.length > 0) {
		lines.push(`Kit ${result.kitName.to} needs these config.json settings; it never applies them:`);
		lines.push(...formatRecommendedSettings(result.unmetSettings));
	}
	lines.push(dryRun ? "Dry run: nothing written." : "Written.");
	return lines;
}

const LEMONADE_HEALTH_TIMEOUT_MS = 1_500;

/** For a kit that runs several local models at once: does Lemonade keep them loaded? Null: nothing to check. */
async function readLocalResidency(
	kitName: string,
	kit: KitDocument,
	config: PipelineConfig,
): Promise<LocalResidencyFinding[] | null> {
	const workingSet = listKitLocalWorkingSet(kit);
	if (workingSet.length < 2) {
		return null;
	}
	const apiBaseUrl = lemonadeApiBaseUrl((await readLemonadeModelListSettings()).settings.url);
	try {
		const maxLlm = await fetchLemonadeMaxLoadedLlms(apiBaseUrl, fetch, LEMONADE_HEALTH_TIMEOUT_MS);
		if (maxLlm === null) {
			return null;
		}
		return assessLocalResidency({
			kitName,
			workingSet,
			lemonadeMaxLlm: maxLlm,
			kanbanCapacity: config.models.providerCapacity[LEMONADE_PROVIDER]?.maxLoadedModels,
		});
	} catch (error) {
		return [
			{ level: "warn", message: `not checked: ${apiBaseUrl}/health did not answer (${toErrorMessage(error)})` },
		];
	}
}

function formatSettingChange(response: KitSettingChangeResponse, workspaceId: string): string[] {
	const lines = response.changes.map(
		(change) =>
			`  ${change.key}: ${change.from === undefined ? "(none)" : JSON.stringify(change.from)} -> ${change.to === undefined ? "(none)" : JSON.stringify(change.to)}`,
	);
	return [
		`Workspace ${workspaceId} (kit ${response.kitName}): ${lines.length > 0 ? "project settings changed, in effect now" : "nothing changed"}`,
		...lines,
		...(response.historyPath ? [`History: ${response.historyPath}`] : []),
	];
}

/** `kit set`/`kit unset` go through the running server, which decides who is asking (the user, the orchestrator). */
async function changeKitSetting(
	options: { project?: string; json?: boolean },
	change: (client: ReturnType<typeof createRuntimeTrpcClient>) => Promise<KitSettingChangeResponse>,
	failureLabel: string,
): Promise<void> {
	try {
		const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: false });
		const client = createRuntimeTrpcClient(target.workspaceId);
		let response: KitSettingChangeResponse;
		try {
			response = await change(client);
		} catch (error) {
			throw new Error(
				`the running Kanban server didn't answer (${toErrorMessage(error)}); project settings change only through it, because it checks who is asking`,
			);
		}
		if (options.json) {
			printJson({ workspaceId: target.workspaceId, ...response });
		}
		if (!response.ok) {
			throw new Error(response.error ?? "refused");
		}
		if (!options.json) {
			printLines(formatSettingChange(response, target.workspaceId));
		}
	} catch (error) {
		process.stderr.write(`${failureLabel} failed: ${toErrorMessage(error)}\n`);
		process.exitCode = 1;
	}
}

function formatMigrationPlan(plan: OverrideMigrationPlan & { written: boolean }, dryRun: boolean): string[] {
	if (plan.unchanged) {
		return [`Workspace ${plan.workspaceId}: its overrides are project settings already; nothing to migrate.`];
	}
	const lines = [
		`Workspace ${plan.workspaceId}: kit ${plan.fromKit}${plan.toKit !== plan.fromKit ? ` -> ${plan.toKit} (new user kit ${plan.userKitPath})` : ""}; routing stays the same (checked).`,
		"Overrides (stored key -> where it goes):",
	];
	for (const row of plan.rows) {
		const targets = row.to.map((target) =>
			target.kind === "project"
				? `project setting ${target.key}`
				: target.kind === "dropped"
					? `dropped (${target.why})`
					: `user kit ${target.kitName} (${target.key})`,
		);
		lines.push(`  ${row.from} -> ${[...new Set(targets)].join("; ")}`);
	}
	lines.push(dryRun ? "Dry run: nothing written." : "Written.");
	return lines;
}

export function registerKitCommand(program: Command): void {
	const kit = program
		.command("kit")
		.description(
			"Routing kits: the per-project policy for dev agents, QA and failures (default: the `default` kit).",
		);

	kit.command("list")
		.description("List the built-in and user kits and the workspaces that use them.")
		.option("--json", "Print as JSON.")
		.action(async (options: { json?: boolean }) => {
			try {
				const [catalog, { config, issues }] = await Promise.all([loadKitCatalog(), readPipelineConfig()]);
				const usedBy = new Map<string, string[]>();
				for (const [workspaceId, settings] of Object.entries(config.workspaces)) {
					const name = settings.kit?.name ?? "default";
					usedBy.set(name, [...(usedBy.get(name) ?? []), workspaceId]);
				}
				const kits = [...catalog.kits.values()].map(({ kit: document, origin }) => ({
					name: document.name,
					description: document.description ?? null,
					origin: origin.kind === "built-in" ? "built-in" : origin.path,
					workspaces: usedBy.get(document.name) ?? [],
				}));
				if (options.json) {
					printJson({ ok: true, kitsDir: getKanbanKitsPath(), kits, errors: catalog.errors, issues });
					return;
				}
				const lines = kits.map(
					(entry) =>
						`${entry.name}  (${entry.origin})${entry.description ? `  ${entry.description}` : ""}${entry.workspaces.length > 0 ? `\n    workspaces: ${entry.workspaces.join(", ")}` : ""}`,
				);
				lines.push("", `User kits: ${getKanbanKitsPath()}/<name>.json. Workspaces without a kit use default.`);
				for (const error of catalog.errors) {
					lines.push(`Refused ${error.path}: ${error.error}`);
				}
				for (const issue of issues) {
					lines.push(`Config: ${issue}`);
				}
				printLines(lines);
			} catch (error) {
				process.stderr.write(`Kit list failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

	kit.command("show")
		.description(
			"Show a kit's team definition (roles with their effective models and sources, the fallback and its triggers), the project's settings and their history, how it answers the routing questions, and every resolved value with its source.",
		)
		.argument("[name]", "Kit name. With --project and no name: the workspace's kit.")
		.option("--project <workspace>", "Workspace id or project path: resolve with that workspace's project settings.")
		.option("--json", "Print as JSON.")
		.action(async (name: string | undefined, options: { project?: string; json?: boolean }) => {
			try {
				const [catalog, { config, issues }, runtimeConfig] = await Promise.all([
					loadKitCatalog(),
					readPipelineConfig(),
					loadGlobalRuntimeConfig(),
				]);
				// No name and no --project: the current directory's workspace if it is one, else the default kit.
				const target =
					options.project !== undefined
						? await resolveWorkspaceTarget(options.project, { allowUnregistered: true })
						: name === undefined
							? await resolveWorkspaceTarget(undefined, { allowUnregistered: false }).catch(() => null)
							: null;
				const workspace = target ? resolveWorkspaceKit(config, target.workspaceId, catalog) : null;
				let kitName: string;
				let resolution: ReturnType<typeof resolveKitByName>;
				if (workspace && (name === undefined || name === workspace.kitName)) {
					kitName = workspace.kitName;
					resolution = { ok: true, kit: workspace.kit, sources: workspace.sources };
				} else {
					kitName = name ?? "default";
					// Another kit for a workspace: shown with the workspace's overrides, as `kit apply` would resolve it.
					resolution = resolveKitByName(catalog, kitName, workspace?.overrides ?? {});
				}
				if (!resolution.ok) {
					throw new Error(resolution.error);
				}
				const classified =
					workspace && kitName === workspace.kitName
						? describeProjectSettings(catalog, kitName, workspace.overrides)
						: null;
				const historyPath = target ? getKitSettingsHistoryPath(target.workspaceId) : null;
				const report = buildKitReport({
					kitName,
					resolved: resolution,
					projectSettings:
						target && classified && historyPath
							? {
									workspaceId: target.workspaceId,
									classified,
									historyPath,
									history: await readKitSettingsHistory(historyPath),
								}
							: null,
					workspaceId: target?.workspaceId ?? NO_WORKSPACE_ID,
					selectedAgentId: runtimeConfig.selectedAgentId,
					maxFailRounds: config.pipeline.rework.maxFailRounds,
					outageMaxMin: config.pipeline.recovery.outage.maxMin,
					config,
					localResidency: await readLocalResidency(kitName, resolution.kit, config),
				});
				const landingMode = target ? getWorkspacePipelineSettings(config, target.workspaceId).landing.mode : null;
				if (options.json) {
					printJson({
						ok: true,
						workspaceId: target?.workspaceId ?? null,
						landingMode,
						issues: [...issues, ...(workspace?.issues ?? [])],
						...report,
					});
					return;
				}
				const lines: string[] = [];
				if (target) {
					lines.push(
						`Workspace ${target.workspaceId}${target.repoPath ? ` (${target.repoPath})` : " (not registered)"}: kit ${workspace?.kitName ?? "default"}, landing mode ${landingMode}`,
					);
					for (const issue of workspace?.issues ?? []) {
						lines.push(`Issue: ${issue}`);
					}
					lines.push("");
				}
				lines.push(...formatKitReport(report));
				printLines(lines);
			} catch (error) {
				process.stderr.write(`Kit show failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

	kit.command("apply")
		.description(
			"Use a kit for a workspace (the user's: it changes the project's team). Keeps its project settings; --set/--unset edit them (--set takes only role models and project facts). The landing mode changes only with --landing.",
		)
		.argument("<name>", "Kit name.")
		.option(
			"--project <workspace>",
			"Workspace id or project path. Defaults to the project containing the current directory.",
		)
		.option("--landing <mode>", "Also set the landing mode: off, commit, pr or qa.")
		.option(
			"--set <key=value>",
			"Set a project setting (roles.<role>.agent|provider|model|tier or a project fact; the value is JSON or text). Repeatable.",
			collect,
			[],
		)
		.option("--unset <key>", "Remove a stored override (a team key too). Repeatable.", collect, [])
		.option("--dry-run", "Print what would change; write nothing.")
		.option(
			"--allow-provisional",
			"Also allow the vetted model registry's provisional combinations for this project (workspaces.<id>.models.allowProvisional).",
		)
		.option("--json", "Print as JSON.")
		.action(
			async (
				name: string,
				options: {
					project?: string;
					landing?: string;
					set: string[];
					unset: string[];
					dryRun?: boolean;
					allowProvisional?: boolean;
					json?: boolean;
				},
			) => {
				try {
					const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: false });
					const result = await applyWorkspaceKit({
						workspaceId: target.workspaceId,
						kitName: name,
						landing: parseLandingMode(options.landing),
						set: parseSetAssignments(options.set),
						unset: options.unset,
						dryRun: options.dryRun === true,
						allowProvisional: options.allowProvisional === true,
					});
					if (options.json) {
						printJson({ ok: true, ...result });
					} else {
						printLines(formatApplyResult(result, options.dryRun === true));
					}
				} catch (error) {
					process.stderr.write(`Kit apply failed: ${toErrorMessage(error)}\n`);
					process.exitCode = 1;
				}
			},
		);

	kit.command("set")
		.description(
			"Set a project setting on the project's kit, in effect at once: a role's model (roles.<role>.agent|provider|model|tier, for a role the kit defines) or a project fact (qa.blurb, qa.promptNotes.*, qa.serversScript, qa.preview, land.postLand, plan.rules, checks.envFile|databaseUrlVar|setup|teardown). Only the user and the project's own orchestrator; never a card. The team definition (flow, triggers, QA routes, tiers, ...) is the kit's: pick another kit with kanban kit apply.",
		)
		.argument("<key>", "Dotted kit key, e.g. roles.fallback.model.")
		.argument("<value>", 'JSON (true, 3, null, [..], {..}, "text") or plain text.')
		.option(
			"--project <workspace>",
			"Workspace id or project path. Defaults to the project containing the current directory.",
		)
		.option("--json", "Print as JSON.")
		.action(async (key: string, value: string, options: { project?: string; json?: boolean }) => {
			await changeKitSetting(
				options,
				async (client) => await client.kit.set.mutate({ key, value: parseKitSettingValue(value) }),
				"Kit set",
			);
		});

	kit.command("unset")
		.description(
			"Remove a project setting (a role field, a whole role roles.<role>, or a project fact), so the kit's value applies again. Only the user and the project's own orchestrator.",
		)
		.argument("<key>", "Dotted kit key, e.g. roles.dev.model or roles.dev.")
		.option(
			"--project <workspace>",
			"Workspace id or project path. Defaults to the project containing the current directory.",
		)
		.option("--json", "Print as JSON.")
		.action(async (key: string, options: { project?: string; json?: boolean }) => {
			await changeKitSetting(options, async (client) => await client.kit.unset.mutate({ key }), "Kit unset");
		});

	kit.command("migrate-overrides")
		.description(
			"The user's: turn overrides from before the team/project split into project settings. Legacy model keys become roles.* keys, team keys the kit already has are dropped, the other team keys go into a new user kit (the project's kit with them) that the project then uses. Refused if routing would change.",
		)
		.option(
			"--project <workspace>",
			"Workspace id or project path. Defaults to the project containing the current directory.",
		)
		.option("--into <name>", "Name of the new user kit (default <workspace>-team).")
		.option("--dry-run", "Print where each override goes; write nothing.")
		.option("--json", "Print as JSON.")
		.action(async (options: { project?: string; into?: string; dryRun?: boolean; json?: boolean }) => {
			try {
				const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: false });
				const result = await migrateWorkspaceOverrides({
					workspaceId: target.workspaceId,
					into: options.into,
					dryRun: options.dryRun === true,
				});
				if (options.json) {
					printJson({ ok: true, ...result });
				} else {
					printLines(formatMigrationPlan(result, options.dryRun === true));
				}
			} catch (error) {
				process.stderr.write(`Kit migrate-overrides failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
