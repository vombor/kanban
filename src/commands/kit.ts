import type { Command } from "commander";
import {
	getWorkspacePipelineSettings,
	type LandingMode,
	landingModeSchema,
	type PipelineConfig,
	readPipelineConfig,
} from "../config/pipeline-config";
import { loadGlobalRuntimeConfig } from "../config/runtime-config";
import { readSessionCredential } from "../isolation/cli-scope";
import { applyWorkspaceKit } from "../kits/apply-kit";
import { listKitChoices } from "../kits/kit-choices";
import { buildKitReport, formatKitReport, formatRecommendedSettings, NO_WORKSPACE_ID } from "../kits/kit-report";
import type { KitDocument } from "../kits/kit-schema";
import { assessLocalResidency, type LocalResidencyFinding, listKitLocalWorkingSet } from "../kits/local-residency";
import { migrateWorkspaceOverrides, type OverrideMigrationPlan } from "../kits/migrate-overrides";
import { describeProjectSettings, readKitSettingsHistory } from "../kits/project-settings";
import { formatKitSelection } from "../kits/renamed-kits";
import { loadKitCatalog, resolveKitByName, resolveWorkspaceKit, TEAM_KIT_NAME } from "../kits/resolve-kit";
import {
	createUserKit,
	editUserKit,
	formatKitValue,
	type KitKeyChange,
	type UserKitCreatePlan,
	type UserKitEditPlan,
} from "../kits/user-kit-edit";
import { fetchLocalProviderLimit, RESIDENCY_PROVIDER_IDS } from "../models/local-provider-limits";
import { getKanbanHomePath, getKanbanKitsPath, getKitSettingsHistoryPath } from "../state/kanban-home";
import { readLiveKanbanServerLock } from "../state/kanban-server-lock";
import type { KitApplyRequest, KitApplyResponse, KitSettingChangeResponse } from "../trpc/kit-settings-api";
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

type KitApplyResult = NonNullable<KitApplyResponse["result"]>;
/** The same over the wire, where a key holding `unknown` reads as optional. */
type WireKitApplyResponse = Awaited<
	ReturnType<ReturnType<typeof createRuntimeTrpcClient>["kit"]["applyKit"]["mutate"]>
>;
type WireKitApplyResult = NonNullable<WireKitApplyResponse["result"]>;

function fromWire(result: WireKitApplyResult): KitApplyResult {
	return {
		...result,
		changes: result.changes.map((change) => ({ ...change, from: change.from, to: change.to })),
		dropped: result.dropped.map((dropped) => ({ ...dropped, value: dropped.value })),
		rebased: result.rebased.map((pin) => ({ ...pin, value: pin.value })),
		unmetSettings: result.unmetSettings.map((status) => ({ ...status, current: status.current })),
	};
}

/** `--preset <name>` / `--custom` as kit apply's preset (undefined: neither given). */
export function parsePresetOption(options: { preset?: string; custom?: boolean }): string | null | undefined {
	if (options.preset !== undefined && options.custom) {
		throw new Error("--preset and --custom exclude each other: a preset names the models, --custom takes yours.");
	}
	return options.custom ? null : options.preset;
}

function formatApplyResult(result: KitApplyResult, dryRun: boolean): string[] {
	const from = formatKitSelection({ name: result.kitName.from, preset: result.preset.from });
	const to = formatKitSelection({ name: result.kitName.to, preset: result.preset.to });
	const lines = [`Workspace ${result.workspaceId}: kit ${from} -> ${to}`];
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
	if (result.dropped.length > 0) {
		lines.push(`Dropped project settings that don't fit kit ${to}:`);
		for (const dropped of result.dropped) {
			lines.push(`  ${dropped.key}: ${JSON.stringify(dropped.value)} (${dropped.why})`);
		}
	}
	if (result.rebased.length > 0) {
		lines.push(`Rebased onto the current preset ${result.preset.to}; removed project model pins:`);
		for (const { key, value } of result.rebased) {
			lines.push(`  ${key}: ${JSON.stringify(value)}`);
		}
	}
	if (result.recommendedLandingMode && result.recommendedLandingMode !== result.landing.to) {
		lines.push(
			`Kit ${to} recommends landing mode "${result.recommendedLandingMode}"; it is not applied without --landing ${result.recommendedLandingMode}.`,
		);
	}
	if (result.unmetSettings.length > 0) {
		lines.push(`Kit ${to} needs these config.json settings; it never applies them:`);
		lines.push(...formatRecommendedSettings(result.unmetSettings));
	}
	lines.push(
		dryRun ? "Dry run: nothing written." : `Written.${result.historyPath ? ` History: ${result.historyPath}` : ""}`,
	);
	return lines;
}

/**
 * `kit apply` goes through the running server, which decides who is asking (the user, the project's orchestrator;
 * src/trpc/kit-settings-api.ts). Without a server only a process with no session credential applies in-process: no
 * agent session outlives its server, so that is the user.
 */
async function applyKitThroughServer(workspaceId: string, request: KitApplyRequest): Promise<KitApplyResult> {
	let response: WireKitApplyResponse;
	try {
		response = await createRuntimeTrpcClient(workspaceId).kit.applyKit.mutate(request);
	} catch (error) {
		if (readSessionCredential() || readLiveKanbanServerLock(getKanbanHomePath()) !== null) {
			throw new Error(
				`the running Kanban server didn't answer (${toErrorMessage(error)}); a kit is applied only through it, because it checks who is asking`,
			);
		}
		const result = await applyWorkspaceKit({ workspaceId, ...request });
		return { ...result, historyPath: result.written ? getKitSettingsHistoryPath(workspaceId) : null };
	}
	if (!response.ok || !response.result) {
		throw new Error(response.error ?? "refused");
	}
	return fromWire(response.result);
}

const LOCAL_PROVIDER_TIMEOUT_MS = 1_500;

/** For a kit that runs several models at once on a local provider: does the server keep them loaded? Null: nothing to check. */
async function readLocalResidency(
	kitName: string,
	kit: KitDocument,
	config: PipelineConfig,
): Promise<LocalResidencyFinding[] | null> {
	const findings: LocalResidencyFinding[] = [];
	for (const provider of RESIDENCY_PROVIDER_IDS) {
		const workingSet = listKitLocalWorkingSet(kit, provider);
		if (workingSet.length < 2) {
			continue;
		}
		const limit = await fetchLocalProviderLimit(provider, config, { timeoutMs: LOCAL_PROVIDER_TIMEOUT_MS });
		if (limit.kind === "unreachable") {
			findings.push({ level: "warn", message: `not checked: ${limit.endpoint} did not answer (${limit.error})` });
		} else if (limit.kind === "unconfigured") {
			findings.push({ level: "warn", message: `not checked: ${limit.detail}` });
		} else if (limit.kind === "known") {
			findings.push(
				...assessLocalResidency({
					kitName,
					provider,
					workingSet,
					providerMaxLoaded: limit.maxLoaded,
					kanbanCapacity: config.models.providerCapacity[provider]?.maxLoadedModels,
				}),
			);
		}
	}
	return findings.length > 0 ? findings : null;
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

function formatKitChanges(changes: KitKeyChange[]): string[] {
	return changes.map((change) => `  ${change.key}: ${formatKitValue(change.from)} -> ${formatKitValue(change.to)}`);
}

function formatCreateResult(result: UserKitCreatePlan & { written: boolean; historyPath: string }): string[] {
	return [
		`Kit ${result.name} (${result.path}): a complete copy of ${result.from}, resolved over default.`,
		...(result.changes.length > 0
			? [
					`Differences from ${result.from} (key: ${result.from} -> ${result.name}):`,
					...formatKitChanges(result.changes),
				]
			: [`Same as ${result.from}.`]),
		result.written
			? `Written. History: ${result.historyPath}. Use it for a project with kanban kit apply ${result.name} --project <path>.`
			: "Dry run: nothing written.",
	];
}

function formatEditResult(
	result: UserKitEditPlan & { written: boolean; backupPath: string | null; historyPath: string },
	dryRun: boolean,
): string[] {
	if (result.changes.length === 0) {
		return [`Kit ${result.name} (${result.path}): nothing changed.`];
	}
	const lines = [`Kit ${result.name} (${result.path}):`, ...formatKitChanges(result.changes)];
	if (result.workspaces.length === 0) {
		lines.push("No workspace uses this kit.");
	} else {
		lines.push(
			`Workspaces on this kit${dryRun ? " (they would pick the change up at once)" : ", in effect for them now"}:`,
		);
		for (const { workspaceId, shadowedBy } of result.workspaces) {
			lines.push(
				`  ${workspaceId}${shadowedBy.length > 0 ? ` (its own project settings still win for ${shadowedBy.join(", ")})` : ""}`,
			);
		}
	}
	lines.push(
		dryRun ? "Dry run: nothing written." : `Written. Backup: ${result.backupPath}. History: ${result.historyPath}.`,
	);
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
				const usedBy = new Map<string, Array<{ workspaceId: string; preset: string | null }>>();
				for (const [workspaceId, settings] of Object.entries(config.workspaces)) {
					const name = settings.kit?.name ?? "default";
					usedBy.set(name, [...(usedBy.get(name) ?? []), { workspaceId, preset: settings.kit?.preset ?? null }]);
				}
				const kits = [...catalog.kits.values()].map(({ kit: document, origin }) => ({
					name: document.name,
					description: document.description ?? null,
					origin: origin.kind === "built-in" ? "built-in" : origin.path,
					workspaces: (usedBy.get(document.name) ?? []).map(({ workspaceId }) => workspaceId),
				}));
				const presets = [...catalog.presets.values()].map((preset) => ({
					name: preset.name,
					description: preset.description ?? null,
					workspaces: (usedBy.get(TEAM_KIT_NAME) ?? [])
						.filter((use) => use.preset === preset.name)
						.map(({ workspaceId }) => workspaceId),
				}));
				const customTeams = (usedBy.get(TEAM_KIT_NAME) ?? [])
					.filter((use) => use.preset === null)
					.map(({ workspaceId }) => workspaceId);
				if (options.json) {
					printJson({
						ok: true,
						kitsDir: getKanbanKitsPath(),
						kits,
						presets,
						customTeams,
						errors: catalog.errors,
						issues,
					});
					return;
				}
				const lines = kits.map(
					(entry) =>
						`${entry.name}  (${entry.origin})${entry.description ? `  ${entry.description}` : ""}${entry.workspaces.length > 0 ? `\n    workspaces: ${entry.workspaces.join(", ")}` : ""}`,
				);
				lines.push("", `Presets of the ${TEAM_KIT_NAME} kit (its models; kanban kit presets shows their roles):`);
				for (const preset of presets) {
					lines.push(
						`  ${preset.name}${preset.description ? `  ${preset.description}` : ""}${preset.workspaces.length > 0 ? `\n    workspaces: ${preset.workspaces.join(", ")}` : ""}`,
					);
				}
				lines.push(
					`  custom  the project's own role models (kanban kit apply ${TEAM_KIT_NAME} --custom --set roles.<role>.agent=...)${customTeams.length > 0 ? `\n    workspaces: ${customTeams.join(", ")}` : ""}`,
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
		.option("--preset <name>", `The ${TEAM_KIT_NAME} kit's preset to show (kanban kit presets).`)
		.option("--custom", `The ${TEAM_KIT_NAME} kit without a preset (a custom team).`)
		.option("--project <workspace>", "Workspace id or project path: resolve with that workspace's project settings.")
		.option("--json", "Print as JSON.")
		.action(
			async (
				name: string | undefined,
				options: { preset?: string; custom?: boolean; project?: string; json?: boolean },
			) => {
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
					const presetOption = parsePresetOption(options);
					const isWorkspaceKit =
						workspace !== null &&
						(name === undefined ||
							(name === workspace.kitName &&
								(presetOption === undefined || presetOption === workspace.presetName)));
					let kitName: string;
					let preset: string | null;
					let resolution: ReturnType<typeof resolveKitByName>;
					if (workspace && isWorkspaceKit) {
						kitName = workspace.kitName;
						preset = workspace.presetName;
						resolution = { ok: true, kit: workspace.kit, sources: workspace.sources };
					} else {
						kitName = name ?? "default";
						preset = presetOption ?? (workspace && kitName === workspace.kitName ? workspace.presetName : null);
						// Another kit for a workspace: shown with the workspace's overrides, as `kit apply` would resolve it.
						resolution = resolveKitByName(catalog, kitName, workspace?.overrides ?? {}, preset);
					}
					if (!resolution.ok) {
						throw new Error(resolution.error);
					}
					const classified =
						workspace && isWorkspaceKit
							? describeProjectSettings(catalog, kitName, workspace.overrides, preset)
							: null;
					const kitLabel = formatKitSelection({ name: kitName, preset });
					const historyPath = target ? getKitSettingsHistoryPath(target.workspaceId) : null;
					const report = buildKitReport({
						kitName: kitLabel,
						description: preset !== null ? (catalog.presets.get(preset)?.description ?? null) : null,
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
						localResidency: await readLocalResidency(kitLabel, resolution.kit, config),
					});
					const landingMode = target
						? getWorkspacePipelineSettings(config, target.workspaceId).landing.mode
						: null;
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
							`Workspace ${target.workspaceId}${target.repoPath ? ` (${target.repoPath})` : " (not registered)"}: kit ${workspace ? formatKitSelection({ name: workspace.kitName, preset: workspace.presetName }) : "default"}, landing mode ${landingMode}`,
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
			},
		);

	kit.command("presets")
		.description(
			`List the ${TEAM_KIT_NAME} kit's presets: each one's four roles (agent, provider, model). A preset names only models; the workflow is the ${TEAM_KIT_NAME} kit's, the same for every preset and custom team.`,
		)
		.option("--json", "Print as JSON.")
		.action(async (options: { json?: boolean }) => {
			try {
				const choices = listKitChoices(await loadKitCatalog());
				if (options.json) {
					printJson({ ok: true, presets: choices.presets });
					return;
				}
				const lines: string[] = [];
				for (const preset of choices.presets) {
					lines.push(`${preset.name}${preset.description ? `  ${preset.description}` : ""}`);
					for (const role of preset.roles) {
						const model = role.model
							? `${role.provider ? `${role.provider}/` : ""}${role.model}`
							: "its default model";
						lines.push(`  ${role.role.padEnd(9)} ${role.agentId ?? "the dev role's agent"} on ${model}`);
					}
				}
				lines.push(
					"",
					`Use one: kanban kit apply ${TEAM_KIT_NAME} --preset <name> --project <path>. Your own models: kanban kit apply ${TEAM_KIT_NAME} --custom --set roles.dev.agent=<agent> --set roles.qa.agent=<agent> [--set roles.<role>.provider|model=...].`,
					"The fallback starts at once without approval: a paid fallback model runs and costs without asking.",
				);
				printLines(lines);
			} catch (error) {
				process.stderr.write(`Kit presets failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

	kit.command("apply")
		.description(
			"Use a kit for a workspace (another team for the project). Only the user and the project's own orchestrator; never a card. Keeps the project settings that fit the new kit and reports the ones it drops; --set/--unset edit them (--set takes only model settings and project facts). The landing mode changes only with --landing.",
		)
		.argument("<name>", `Kit name (${TEAM_KIT_NAME} needs --preset <name> or --custom).`)
		.option("--preset <name>", `The ${TEAM_KIT_NAME} kit's models: a preset (kanban kit presets).`)
		.option(
			"--custom",
			`The ${TEAM_KIT_NAME} kit with the project's own models: needs --set roles.dev.agent=... and --set roles.qa.agent=... (and .provider/.model).`,
		)
		.option(
			"--project <workspace>",
			"Workspace id or project path. Defaults to the project containing the current directory.",
		)
		.option(
			"--landing <mode>",
			"Also set the landing mode: off, commit, pr or qa (the user and the project's own orchestrator).",
		)
		.option(
			"--set <key=value>",
			"Set a project setting (a model the kit names, e.g. roles.<role>.model or tiers.<tier>.<i>.model, or a project fact; the value is JSON or text). Repeatable.",
			collect,
			[],
		)
		.option("--unset <key>", "Remove a stored override (a team key too, by the user only). Repeatable.", collect, [])
		.option("--dry-run", "Print what would change; write nothing.")
		.option(
			"--rebase",
			"Opt in to following the current preset again: drop project model pins, keep project facts and team keys.",
		)
		.option(
			"--rebase-key <key>",
			"With --rebase: drop only this stored model pin. Repeatable; otherwise all model pins are dropped.",
			collect,
			[],
		)

		.option("--json", "Print as JSON.")
		.action(
			async (
				name: string,
				options: {
					preset?: string;
					custom?: boolean;
					project?: string;
					landing?: string;
					set: string[];
					unset: string[];
					dryRun?: boolean;
					rebase?: boolean;
					rebaseKey: string[];
					json?: boolean;
				},
			) => {
				try {
					const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: false });
					const preset = parsePresetOption(options);
					const result = await applyKitThroughServer(target.workspaceId, {
						kitName: name,
						...(preset !== undefined ? { preset } : {}),
						landing: parseLandingMode(options.landing),
						set: parseSetAssignments(options.set),
						unset: options.unset,
						dryRun: options.dryRun === true,
						rebase: options.rebase === true,
						rebaseKeys: options.rebaseKey,
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
			"Set a project setting on the project's kit, in effect at once: any model the kit names (roles.<role>.agent|provider|model|tier for a role the kit defines; tiers.<tier> or tiers.<tier>.<i>.provider|model|default; qa.routes.<i>.agent|provider|model; plan.candidates.<i>.agent|model|model.provider|model.model|model.tier; onFail.runoff.models.<i>.agent|provider|model; only tiers and entries the kit has) or a project fact (qa.blurb, qa.promptNotes.*, qa.serversScript, qa.preview, land.postLand, plan.rules, checks.envFile|databaseUrlVar|setup|teardown, worktrees.symlinkIgnored.include|exclude). Only the user and the project's own orchestrator; never a card. The flow (onFail, fallback triggers and approval, qa.enabled/rules, a route's devModel, requireDifferentVendor, features) is the kit's: use another kit with kanban kit apply.",
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
			"Remove a project setting (a model setting, a whole role roles.<role> or list entry, or a project fact), so the kit's value applies again. Only the user and the project's own orchestrator.",
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

	kit.command("create")
		.description(
			"The user's: make a user kit (<home>/kits/<name>.json) as a complete copy of another kit, resolved over default (kits don't inherit), with team-definition keys changed by --set. Prints how it differs from --from.",
		)
		.argument("<name>", "Name of the new kit (lowercase letters, digits, '-', '_'; not a built-in or existing kit).")
		.requiredOption("--from <kit>", "The kit to copy (built-in or user).")
		.option("--preset <name>", "With --from team: the preset whose models the copy gets (kanban kit presets).")
		.option(
			"--set <key=value>",
			"Set a team-definition key (e.g. fallback.on.conflict=false; the value is JSON or text). Repeatable.",
			collect,
			[],
		)
		.option("--description <text>", "The kit's description.")
		.option("--dry-run", "Print the differences; write nothing.")
		.option("--json", "Print as JSON.")
		.action(
			async (
				name: string,
				options: {
					from: string;
					preset?: string;
					set: string[];
					description?: string;
					dryRun?: boolean;
					json?: boolean;
				},
			) => {
				try {
					const result = await createUserKit({
						name,
						from: options.from,
						preset: options.preset,
						set: parseSetAssignments(options.set),
						description: options.description,
						dryRun: options.dryRun === true,
					});
					if (options.json) {
						printJson({ ok: true, ...result });
					} else {
						printLines(formatCreateResult(result));
					}
				} catch (error) {
					process.stderr.write(`Kit create failed: ${toErrorMessage(error)}\n`);
					process.exitCode = 1;
				}
			},
		);

	kit.command("edit")
		.description(
			"The user's: change team-definition keys of a user kit (never a built-in one). Validated, backed up under <home>/backups/kits/, written atomically; every workspace on the kit picks the change up at once (they are listed).",
		)
		.argument("<name>", "User kit name.")
		.option(
			"--set <key=value>",
			"Set a team-definition key (e.g. fallback.on.qaStalled=false; the value is JSON or text). Repeatable.",
			collect,
			[],
		)
		.option(
			"--unset <key>",
			"Remove a key from the kit, so the default kit's value applies. Repeatable.",
			collect,
			[],
		)
		.option("--dry-run", "Print what would change; write nothing.")
		.option("--json", "Print as JSON.")
		.action(async (name: string, options: { set: string[]; unset: string[]; dryRun?: boolean; json?: boolean }) => {
			try {
				const result = await editUserKit({
					name,
					set: parseSetAssignments(options.set),
					unset: options.unset,
					dryRun: options.dryRun === true,
				});
				if (options.json) {
					printJson({ ok: true, ...result });
				} else {
					printLines(formatEditResult(result, options.dryRun === true));
				}
			} catch (error) {
				process.stderr.write(`Kit edit failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
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
