// What `kanban kit show` prints: every resolved value with its source, and the evaluator's answers for a few
// sample cards, so a kit's routing can be read without running the pipeline. This is the only caller of the
// evaluator until the pipeline (P4-1) and card creation (P3-5) use it.

import type { LandingMode, PipelineConfig } from "../config/pipeline-config";
import type { RuntimeAgentId, RuntimeBoardCard } from "../core/api-contract";
import type { EffectiveModel } from "../core/effective-agent";
import { describeCombination } from "../models/vetted-registry";
import {
	describeRecommendedValue,
	evaluateKitRecommendedSettings,
	type KitRecommendedSettingStatus,
} from "./kit-recommendations";
import { FALLBACK_TRIGGERS, getKitFallbackFlow, type KitRoleAssignment, listKitRoles } from "./kit-roles";
import { getUsableTierEntries, type KitDocument, type KitFallbackTrigger, type KitRoleName } from "./kit-schema";
import type { LocalResidencyFinding } from "./local-residency";
import {
	answerPlanAssignment,
	type CardHistory,
	createRoutingPolicy,
	type DevAssignmentAnswer,
	type EffectiveCard,
	type OnFailAnswer,
	type OnOutageAnswer,
	type OnPassAnswer,
	type PlanAssignmentAnswer,
	type QaPolicyAnswer,
} from "./policy";
import type { ClassifiedOverrides, KitSettingsHistoryEntry } from "./project-settings";
import { type ResolvedKit, readKitValue } from "./resolve-kit";
import {
	checkKitRoutes,
	getStrictRoutingVetting,
	getWorkspaceRoutingVetting,
	type KitRouteCheck,
} from "./routing-vetting";

/** The `workspaceId` `kanban kit show` passes when it shows a kit without a project. */
export const NO_WORKSPACE_ID = "(none)";

export interface KitValueRow {
	key: string;
	value: unknown;
	source: string;
}

/** A role of the team with its effective agent and model, and where each came from. */
export interface KitRoleRow extends KitRoleAssignment {
	/** The source of `roles.<role>.agent` and of its model (`model`/`tier`); null = not set anywhere. */
	sources: { agent: string | null; model: string | null };
}

/** The fallback part of the team definition, with the effective values the core uses. */
export interface KitFallbackReport {
	role: KitRoleName;
	on: KitFallbackTrigger[];
	off: KitFallbackTrigger[];
	/** After how many failed QA rounds (`onFail.reworkRounds`, capped by the core). */
	failRounds: number;
	/** `fallback.outageAfterMin`, else `pipeline.recovery.outage.maxMin`. */
	outageAfterMin: number;
	requireApproval: boolean;
	/** `onFail.then`: "stop" means no trigger but outage can hand a card over. */
	onFailThen: "escalate" | "stop";
}

/** The workspace's project settings (`kanban kit set`), shown with `kanban kit show --project`. */
export interface KitProjectSettingsReport {
	workspaceId: string;
	classified: ClassifiedOverrides;
	historyPath: string;
	history: KitSettingsHistoryEntry[];
}

export interface KitReport {
	kitName: string;
	description: string | null;
	roles: KitRoleRow[];
	fallback: KitFallbackReport;
	projectSettings: KitProjectSettingsReport | null;
	values: KitValueRow[];
	devAssignment: DevAssignmentAnswer;
	planAssignment: PlanAssignmentAnswer;
	qa: Array<{ devAgentId: RuntimeAgentId; devModel: EffectiveModel | null; answer: QaPolicyAnswer }>;
	onFail: Array<{ case: string; answer: OnFailAnswer }>;
	onPass: OnPassAnswer;
	/** The answer for a card held `minutes` for a provider outage: its takeover time, or recovery's give-up time. */
	onOutage: { minutes: number; answer: OnOutageAnswer };
	/** QA answers the kit refuses (for example a route whose QA vendor equals the dev vendor). */
	warnings: string[];
	/** Every combination the kit routes to, against the vetted model registry (this workspace's rule). */
	vetting: KitRouteCheck[];
	/** Shown, never applied without `kanban kit apply --landing`. */
	recommendedLandingMode: LandingMode | null;
	/** `recommends.settings` against the config the report was built with; never applied by the kit. */
	recommendedSettings: KitRecommendedSettingStatus[];
	/** Whether the local server keeps the kit's models loaded side by side; null: not checked (no local models). */
	localResidency: LocalResidencyFinding[] | null;
}

export function listKitValues(resolved: ResolvedKit): KitValueRow[] {
	return Object.entries(resolved.sources)
		.map(([key, source]) => ({ key, value: readKitValue(resolved.kit, key), source }))
		.sort((left, right) => left.key.localeCompare(right.key));
}

function createSampleCard(workspaceId: string, agentId: RuntimeAgentId, model: EffectiveModel | null): EffectiveCard {
	const card: RuntimeBoardCard = {
		id: "sample",
		title: "sample dev card",
		prompt: "",
		startInPlanMode: false,
		baseRef: "",
		createdAt: 0,
		updatedAt: 0,
	};
	return { card, workspaceId, role: "dev", agentId, model };
}

function emptyHistory(failRounds: number[]): CardHistory {
	return {
		failRounds,
		reworks: Math.max(0, failRounds.length - 1),
		nudges: 0,
		escalations: 0,
		handbacks: 0,
		extraRounds: 0,
	};
}

/** Dev models worth showing QA answers for: the kit's own dev model, every usable tier model, and "no model known". */
function listSampleDevModels(kit: KitDocument, assigned: EffectiveModel | null): Array<EffectiveModel | null> {
	const samples = new Map<string, EffectiveModel | null>();
	if (assigned) {
		samples.set(assigned.model, assigned);
	}
	for (const tier of Object.keys(kit.tiers ?? {})) {
		for (const entry of getUsableTierEntries(kit, tier)) {
			if (!samples.has(entry.model)) {
				samples.set(entry.model, { provider: entry.provider ?? null, model: entry.model });
			}
		}
	}
	samples.set("", null);
	return [...samples.values()];
}

export function buildKitReport(input: {
	kitName: string;
	resolved: ResolvedKit;
	workspaceId: string;
	selectedAgentId: RuntimeAgentId;
	maxFailRounds: number;
	/** `pipeline.recovery.outage.maxMin`: when recovery gives an outage hold up. */
	outageMaxMin: number;
	/** The parsed config.json, to compare the kit's recommended settings with. */
	config: PipelineConfig;
	/** `assessLocalResidency()` against Lemonade's /api/v1/health, from the caller (this module does no I/O). */
	localResidency?: LocalResidencyFinding[] | null;
	/** The workspace's project settings and their history, read by the caller. */
	projectSettings?: KitProjectSettingsReport | null;
}): KitReport {
	const { kit } = input.resolved;
	const vetting =
		input.workspaceId === NO_WORKSPACE_ID
			? getStrictRoutingVetting()
			: getWorkspaceRoutingVetting(input.config, input.workspaceId);
	const policy = createRoutingPolicy(kit, vetting);
	const devAssignment = policy.devAssignment({ workspaceId: input.workspaceId, title: "", prompt: "", role: "dev" });
	const devAgentId = devAssignment?.agentId ?? input.selectedAgentId;
	const qa = listSampleDevModels(kit, devAssignment?.model ?? null).map((devModel) => {
		const dev = createSampleCard(input.workspaceId, devAgentId, devModel);
		return { devAgentId, devModel, answer: policy.qaPolicy({ dev, round: 1, history: emptyHistory([]) }) };
	});
	const warnings = qa.flatMap(({ answer }) =>
		answer.kind === "none" && answer.reason.startsWith("refused:") ? [answer.reason] : [],
	);
	const sample = createSampleCard(input.workspaceId, devAgentId, devAssignment?.model ?? null);
	const limits = { maxFailRounds: input.maxFailRounds };
	const lastRound = Array.from({ length: input.maxFailRounds }, (_, index) => index + 1);
	const failCases: Array<{ case: string; cause: "fail" | "conflict" | "stalled"; failRounds: number[] }> = [
		{ case: "first FAIL", cause: "fail", failRounds: [1] },
		{ case: `FAIL in round ${input.maxFailRounds} (the core cap)`, cause: "fail", failRounds: lastRound },
		{ case: "merge conflict at land", cause: "conflict", failRounds: [1] },
		{ case: "QA STALLED", cause: "stalled", failRounds: [] },
	];
	const outageMinutes = Math.min(kit.fallback?.outageAfterMin ?? input.outageMaxMin, input.outageMaxMin);
	const onFail = failCases.map((failCase) => ({
		case: failCase.case,
		answer: policy.onFail({
			dev: sample,
			cause: failCase.cause,
			verdict: null,
			history: emptyHistory(failCase.failRounds),
			limits,
		}),
	}));
	const { sources } = input.resolved;
	const roles = listKitRoles(kit).map((role) => ({
		...role,
		sources: {
			agent: sources[`roles.${role.role}.agent`] ?? null,
			model: sources[`roles.${role.role}.model`] ?? sources[`roles.${role.role}.tier`] ?? null,
		},
	}));
	const flow = getKitFallbackFlow(kit);
	const fallback: KitFallbackReport = {
		role: "fallback",
		on: FALLBACK_TRIGGERS.filter((trigger) => flow.triggers[trigger]),
		off: FALLBACK_TRIGGERS.filter((trigger) => !flow.triggers[trigger]),
		failRounds: Math.min(kit.onFail?.reworkRounds ?? 0, input.maxFailRounds),
		outageAfterMin: flow.outageAfterMin ?? input.outageMaxMin,
		requireApproval: flow.requireApproval,
		onFailThen: kit.onFail?.then ?? "stop",
	};
	return {
		kitName: input.kitName,
		description: kit.description ?? null,
		roles,
		fallback,
		projectSettings: input.projectSettings ?? null,
		values: listKitValues(input.resolved),
		devAssignment,
		planAssignment: answerPlanAssignment(kit, vetting),
		qa,
		onFail,
		onPass: policy.onPass({ dev: sample, verdict: { verdict: "PASS", round: 1 } }),
		onOutage: {
			minutes: outageMinutes,
			answer: policy.onOutage({ dev: sample, heldMin: outageMinutes, maxMin: input.outageMaxMin }),
		},
		warnings,
		vetting: checkKitRoutes(kit, vetting),
		recommendedLandingMode: kit.recommends?.landingMode ?? null,
		localResidency: input.localResidency ?? null,
		recommendedSettings: evaluateKitRecommendedSettings(
			kit,
			input.config,
			input.workspaceId === NO_WORKSPACE_ID ? null : input.workspaceId,
		),
	};
}

function formatModel(model: EffectiveModel | null | undefined): string {
	return model ? `${model.provider ?? "(agent default provider)"}/${model.model}` : "its own default model";
}

function formatOnFail(answer: OnFailAnswer): string {
	switch (answer.action) {
		case "rework":
			return "rework on the same card and model";
		case "escalate":
			return `escalate to ${answer.to === "orchestrator" ? "the orchestrator" : `${answer.to.agentId} ${formatModel(answer.to.model)}`}${answer.requireApproval ? " (needs approval)" : ""}: ${answer.reason}`;
		case "runoff":
			return `runoff on ${answer.models.map((model) => `${model.agentId} ${model.model}`).join(", ")}`;
		case "stop":
			return `stop: ${answer.reason}`;
	}
}

function describeTrigger(trigger: KitFallbackTrigger, fallback: KitFallbackReport): string {
	switch (trigger) {
		case "qaFails":
			return `${fallback.failRounds} failed QA round(s)`;
		case "qaStalled":
			return "QA stalled";
		case "unchanged":
			return "a rework that came back unchanged";
		case "conflict":
			return "a merge conflict its reworks didn't fix";
		case "outage":
			return `a provider outage hold of ${fallback.outageAfterMin} min`;
	}
}

function formatRoleRow(row: KitRoleRow): string {
	const agent = row.agentId ?? (row.role === "fallback" ? "the dev role's agent" : "the selected agent");
	const model = row.error
		? `no model (${row.error})`
		: `${formatModel(row.model)}${row.tier ? ` (tier ${row.tier})` : ""}`;
	return `    ${row.role.padEnd(9)} ${agent} on ${model}  [agent: ${row.sources.agent ?? "-"}, model: ${row.sources.model ?? "-"}]`;
}

function formatTeamDefinition(report: KitReport): string[] {
	const lines = [
		`Team definition (kit ${report.kitName}; a project changes its team only by using another kit: kanban kit apply, the user's):`,
		"  Roles and their models  [source: project = a project setting, else the kit that set it]:",
	];
	lines.push(
		...(report.roles.length > 0
			? report.roles.map(formatRoleRow)
			: ["    (none: every card runs on the agent selected in Kanban settings)"]),
	);
	const { fallback } = report;
	const fallbackRole = report.roles.find((row) => row.role === "fallback");
	const onFailTriggers = fallback.on.filter((trigger) => trigger !== "outage");
	lines.push(
		"  Fallback (a sibling card on the fallback role's model takes a dev card's task over; the card goes to Backlog):",
	);
	if (!fallbackRole || fallback.on.length === 0) {
		lines.push(
			`    never: ${fallbackRole ? "every trigger is off" : "the kit has no fallback role"}; failures go to the orchestrator`,
		);
	} else {
		lines.push(`    on: ${fallback.on.map((trigger) => describeTrigger(trigger, fallback)).join("; ")}`);
		if (onFailTriggers.length > 0 && fallback.onFailThen === "stop") {
			lines.push("    (onFail.then is stop: only the outage trigger can fire)");
		}
		if (fallback.off.length > 0) {
			lines.push(`    off (the orchestrator instead): ${fallback.off.join(", ")}`);
		}
		lines.push(
			`    approval: ${fallback.requireApproval ? "the sibling waits in Backlog until the orchestrator or the user starts it" : "none, the sibling starts at once"}`,
			"    never (core rule): onto the model the card already runs on, a second time in one chain (a fallback sibling that fails goes to the orchestrator), or from a card racing in a runoff",
		);
	}
	return lines;
}

function formatHistoryActor(entry: KitSettingsHistoryEntry): string {
	switch (entry.by.kind) {
		case "user":
			return "the user";
		case "orchestrator":
			return `the orchestrator (${entry.by.taskId})`;
		case "user-command":
			return `the user (${entry.via})`;
	}
}

function formatProjectSettings(settings: KitProjectSettingsReport): string[] {
	const { classified, workspaceId } = settings;
	const lines = [
		`Project settings of ${workspaceId} (role models and project facts; kanban kit set|unset, by the user or ${workspaceId}'s orchestrator):`,
	];
	const projectKeys = Object.keys(classified.project).sort();
	lines.push(
		...(projectKeys.length > 0
			? projectKeys.map((key) => `  ${key} = ${JSON.stringify(classified.project[key])}`)
			: ["  (none)"]),
	);
	for (const { from, to } of classified.legacy) {
		lines.push(`  legacy key ${from} (means ${to.join(", ") || "nothing"})`);
	}
	const teamKeys = Object.keys(classified.team).sort();
	if (teamKeys.length > 0) {
		lines.push(
			`  Team keys stored as overrides (still applied, but a project can't set them any more): ${teamKeys.join(", ")}`,
			`  → the user moves them into a user kit: kanban kit migrate-overrides --project ${workspaceId} --dry-run`,
		);
	}
	const last = settings.history[settings.history.length - 1];
	lines.push(
		`  History: ${settings.historyPath} (${settings.history.length} change(s)${last ? `; last ${last.at}: ${last.key} by ${formatHistoryActor(last)}` : ""})`,
	);
	return lines;
}

export function formatKitReport(report: KitReport): string[] {
	const lines = [`Kit ${report.kitName}${report.description ? `: ${report.description}` : ""}`, ""];
	lines.push(...formatTeamDefinition(report), "");
	if (report.projectSettings) {
		lines.push(...formatProjectSettings(report.projectSettings), "");
	}
	lines.push("How the kit answers:");
	lines.push("New dev cards (when the creator sets no agent):");
	lines.push(
		report.devAssignment
			? `  ${report.devAssignment.agentId} on ${formatModel(report.devAssignment.model)}${report.devAssignment.tier ? ` (tier ${report.devAssignment.tier})` : ""}`
			: "  no answer: the card runs on the agent selected in Kanban settings",
	);
	const plan = report.planAssignment;
	lines.push("Plan cards (kanban task create --role plan):");
	lines.push(
		plan.kind === "disabled"
			? `  none (${plan.reason}): the dev agent plans its own work`
			: `  ${plan.agentId ?? "the agent selected in Kanban settings"} on ${formatModel(plan.model)}${plan.tier ? ` (tier ${plan.tier})` : ""}${plan.startInPlanMode ? ", starting in plan mode" : ""}${plan.rules.length > 0 ? `, ${plan.rules.length} prompt rule(s)` : ""}`,
	);
	lines.push("QA for a submitted dev card (landing mode qa):");
	for (const { devAgentId, devModel, answer } of report.qa) {
		const card = `${devAgentId} on ${devModel ? devModel.model : "an unknown model"}`;
		lines.push(
			answer.kind === "none"
				? `  ${card}: no QA (${answer.reason})`
				: `  ${card}: ${answer.agentId} on ${formatModel(answer.model)}${answer.route ? ` [${answer.route}]` : " [roles.qa]"}${answer.promptParts.rules.length > 0 ? `, ${answer.promptParts.rules.length} prompt rule(s)` : ""}`,
		);
	}
	lines.push("After a failure:");
	for (const { case: failCase, answer } of report.onFail) {
		lines.push(`  ${failCase}: ${formatOnFail(answer)}`);
	}
	lines.push(`After a PASS: ${report.onPass.action}`);
	const outage = report.onOutage.answer;
	lines.push(
		`After ${report.onOutage.minutes} min of provider outage: ${
			outage.action === "escalate"
				? `take over on ${outage.to.agentId} ${formatModel(outage.to.model)}${outage.requireApproval ? " (needs approval)" : ""}`
				: `keep holding (${outage.reason}); the orchestrator once the hold gives up`
		}`,
	);
	if (report.recommendedLandingMode) {
		lines.push(
			"",
			`Recommends landing mode "${report.recommendedLandingMode}" (applied only with kanban kit apply --landing ${report.recommendedLandingMode}).`,
		);
	}
	if (report.recommendedSettings.length > 0) {
		lines.push("", "Settings this kit needs (config.json; the kit never applies them):");
		lines.push(...formatRecommendedSettings(report.recommendedSettings));
	}
	if (report.localResidency && report.localResidency.length > 0) {
		lines.push("", "Local models loaded side by side (Lemonade /api/v1/health):");
		for (const finding of report.localResidency) {
			lines.push(
				`  ${finding.level === "pass" ? "ok  " : "WARN"} ${finding.message}${finding.hint ? ` → ${finding.hint}` : ""}`,
			);
		}
	}
	if (report.vetting.length > 0) {
		lines.push("", "Routing against the vetted model registry (kanban models list):");
		for (const route of report.vetting) {
			lines.push(
				`  ${route.check.ok ? `ok (${route.check.verdict.status})` : "REFUSED"} ${route.label} → ${describeCombination(route.combination)} for ${route.role}${route.check.ok ? "" : `: ${route.check.message}`}`,
			);
		}
	}
	for (const warning of report.warnings) {
		lines.push(`Warning: ${warning}`);
	}
	lines.push("", "Values (key = value  [source]):");
	for (const row of report.values) {
		lines.push(`  ${row.key} = ${JSON.stringify(row.value)}  [${row.source}]`);
	}
	return lines;
}

/** One line per recommended setting: ok / SET (unmet) / UNKNOWN, the config key, what it is and what it should be. */
export function formatRecommendedSettings(statuses: KitRecommendedSettingStatus[]): string[] {
	return statuses.map(({ setting, configKey, current, status }) => {
		const label = status === "met" ? "ok     " : status === "unmet" ? "SET    " : "UNKNOWN";
		const now = status === "unknown" ? "not a setting in this build" : `now ${JSON.stringify(current)}`;
		return `  ${label} ${configKey} = ${describeRecommendedValue(setting)} (${now}): ${setting.why}`;
	});
}
