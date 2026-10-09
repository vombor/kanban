// What `kanban kit show` prints: every resolved value with its source, and the evaluator's answers for a few
// sample cards, so a kit's routing can be read without running the pipeline. This is the only caller of the
// evaluator until the pipeline (P4-1) and card creation (P3-5) use it.

import type { LandingMode, PipelineConfig } from "../config/pipeline-config";
import type { RuntimeAgentId, RuntimeBoardCard } from "../core/api-contract";
import type { EffectiveModel } from "../core/effective-agent";
import {
	describeRecommendedValue,
	evaluateKitRecommendedSettings,
	type KitRecommendedSettingStatus,
} from "./kit-recommendations";
import { getUsableTierEntries, type KitDocument } from "./kit-schema";
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
import { type ResolvedKit, readKitValue } from "./resolve-kit";

/** The `workspaceId` `kanban kit show` passes when it shows a kit without a project. */
export const NO_WORKSPACE_ID = "(none)";

export interface KitValueRow {
	key: string;
	value: unknown;
	source: string;
}

export interface KitReport {
	kitName: string;
	description: string | null;
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
}): KitReport {
	const { kit } = input.resolved;
	const policy = createRoutingPolicy(kit);
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
	const outageMinutes = Math.min(kit.onOutage?.afterMin ?? input.outageMaxMin, input.outageMaxMin);
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
	return {
		kitName: input.kitName,
		description: kit.description ?? null,
		values: listKitValues(input.resolved),
		devAssignment,
		planAssignment: answerPlanAssignment(kit),
		qa,
		onFail,
		onPass: policy.onPass({ dev: sample, verdict: { verdict: "PASS", round: 1 } }),
		onOutage: {
			minutes: outageMinutes,
			answer: policy.onOutage({ dev: sample, heldMin: outageMinutes, maxMin: input.outageMaxMin }),
		},
		warnings,
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

export function formatKitReport(report: KitReport): string[] {
	const lines = [`Kit ${report.kitName}${report.description ? `: ${report.description}` : ""}`, ""];
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
				: `  ${card}: ${answer.agentId} on ${formatModel(answer.model)}${answer.route ? ` [${answer.route}]` : " [qa.default]"}${answer.promptParts.rules.length > 0 ? `, ${answer.promptParts.rules.length} prompt rule(s)` : ""}`,
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
