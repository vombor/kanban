// `kanban models vet`'s runner (docs/team/MODELS.md "Vetting"): one throwaway smoke-test card for one agent +
// provider + model and role, driven through the running server like `kanban bench calibrate` (create, start, watch,
// discard), with role `calibration` so the pipeline, auto-review and the watchdog's stall checks leave it alone.
//
// It watches the run with Kanban's failure detectors and stops at the first one: the agent not signed in, no turn
// started (`no_session`: a sign-in screen takes the prompt as input), an image rejection, tool calls written as text,
// a tool-call loop, the agent-specific stalls (vet-probe.ts: Cline's silent stall, hung request, context overflow,
// provider error), a session that failed, no progress for `stallMin`, the time cap and the cost cap. A turn that
// ends (Review, settled) is then checked against the task (vet-tasks.ts). The card is always discarded, never landed.
//
// The result is a report and a proposed registry entry (vet-report.ts). It never edits the registry: the Kanban
// orchestrator commits the proposal to models/vetted.json.
import type { RuntimeAgentId, RuntimeTaskAgentSettings, RuntimeTaskSessionSummary } from "../../core/api-contract";
import { isReviewSettled } from "../../terminal/review-settle";
import type { ModelCombination, VettingRole } from "../vetted-registry";
import type { VetFailure, VetProbeInput } from "./vet-probe";
import { checkVetTask, type VetCheck, type VetCheckDeps, type VetTask } from "./vet-tasks";

export interface VetLimits {
	/** The whole run, from the card's start. */
	maxMin: number;
	maxCostUSD: number;
	/** No progress (hook, agent file, scratch repo write) for this long while running = a silent stall. */
	stallMin: number;
	/** No turn started this long after the start = `no_session`. */
	startMin: number;
	/** How often the run is looked at. */
	pollSec: number;
	/** A finished turn must stay finished this long (Review settles, src/terminal/review-settle.ts). */
	reviewSettleMs: number;
}

export const DEFAULT_VET_LIMITS: VetLimits = {
	maxMin: 30,
	maxCostUSD: 2,
	stallMin: 8,
	startMin: 4,
	pollSec: 10,
	reviewSettleMs: 12_000,
};

export interface VetBoardState {
	columnId: string | null;
	session: RuntimeTaskSessionSummary | null;
}

export interface VetRunnerDeps {
	board: {
		createTask: (input: {
			title: string;
			prompt: string;
			agentId: RuntimeAgentId;
			agentSettings: RuntimeTaskAgentSettings | undefined;
		}) => Promise<string>;
		startTask: (taskId: string) => Promise<void>;
		/** Stops the card and discards it (never lands). */
		discardTask: (taskId: string) => Promise<void>;
		readTask: (taskId: string) => Promise<VetBoardState>;
	};
	signals: {
		isSignedIn: (agentId: RuntimeAgentId) => Promise<boolean | null>;
		hasStartedTurn: (agentId: RuntimeAgentId, workspacePath: string) => Promise<boolean | null>;
		hasImageRejection: (agentId: RuntimeAgentId, workspacePath: string) => Promise<boolean | null>;
		countToolUse: (
			agentId: RuntimeAgentId,
			workspacePath: string,
		) => Promise<{ native: number; textual: number; turns: number } | null>;
		findToolCallLoop: (
			agentId: RuntimeAgentId,
			workspacePath: string,
		) => Promise<{ count: number; of: number; call: string } | null>;
	};
	/** The agent-specific failure detectors (vet-probe.ts). */
	probe: (input: VetProbeInput) => Promise<VetFailure | null>;
	findWorktreePath: (taskId: string) => Promise<string | null>;
	/** The card's cost so far (the scoreboard's metrics), or null when it can't be told. */
	measureCostUSD: (taskId: string) => Promise<number | null>;
	/** The newest write under the scratch repo (ms), as progress the agent made. */
	readLatestWriteAt: (repoPath: string) => Promise<number | null>;
	checks: VetCheckDeps;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	log: (message: string) => void;
}

export interface VetRunInput {
	runId: string;
	combination: ModelCombination;
	role: VettingRole;
	task: VetTask;
	repoPath: string;
	limits: VetLimits;
}

export type VetOutcome = "passed" | "failed";

export interface VetRunResult {
	runId: string;
	combination: ModelCombination;
	role: VettingRole;
	outcome: VetOutcome;
	/** The first failure detector that fired, or the failed checks. */
	failure: VetFailure | null;
	checks: VetCheck[];
	taskId: string | null;
	startedAt: number;
	finishedAt: number;
	costUSD: number | null;
	toolUse: { native: number; textual: number; turns: number } | null;
	/** Whether the turn ended in a way Kanban saw (Review). */
	turnEnded: boolean;
	sawImageRejection: boolean;
}

const COST_CHECK_MS = 60_000;

function toAgentSettings(combination: ModelCombination): RuntimeTaskAgentSettings | undefined {
	if (!combination.provider && !combination.model) {
		return undefined;
	}
	return {
		...(combination.provider ? { providerId: combination.provider } : {}),
		...(combination.model ? { modelId: combination.model } : {}),
	};
}

function minutes(ms: number): number {
	return Math.round(ms / 6_000) / 10;
}

export async function runVet(input: VetRunInput, deps: VetRunnerDeps): Promise<VetRunResult> {
	const { combination, limits } = input;
	const agentId = combination.agentId;
	const startedAt = deps.now();
	const base = { runId: input.runId, combination, role: input.role };
	let taskId: string | null = null;
	let costUSD: number | null = null;
	let toolUse: VetRunResult["toolUse"] = null;
	let turnEnded = false;
	let sawImageRejection = false;
	const finish = (failure: VetFailure | null, checks: VetCheck[] = []): VetRunResult => ({
		...base,
		outcome: failure === null && checks.every((check) => check.ok) ? "passed" : "failed",
		failure:
			failure ??
			(checks.some((check) => !check.ok)
				? {
						kind: "task",
						detail: checks
							.filter((check) => !check.ok)
							.map((check) => `${check.name}: ${check.detail}`)
							.join("; "),
					}
				: null),
		checks,
		taskId,
		startedAt,
		finishedAt: deps.now(),
		costUSD,
		toolUse,
		turnEnded,
		sawImageRejection,
	});

	if ((await deps.signals.isSignedIn(agentId)) === false) {
		return finish({ kind: "sign_in", detail: `${agentId} has no login it can start a run with` });
	}
	taskId = await deps.board.createTask({
		title: `VET ${input.role}: ${agentId} ${combination.model ?? "(default model)"} (${input.runId})`,
		prompt: input.task.prompt(input.repoPath),
		agentId,
		agentSettings: toAgentSettings(combination),
	});
	deps.log(`vet ${input.runId}: card ${taskId} created`);
	try {
		await deps.board.startTask(taskId);
		const runStartedAt = deps.now();
		let lastCostCheck = 0;
		let lastProgressAt = runStartedAt;
		for (;;) {
			await deps.sleep(limits.pollSec * 1000);
			const now = deps.now();
			const { columnId, session } = await deps.board.readTask(taskId);
			const worktreePath = await deps.findWorktreePath(taskId);
			if (now - lastCostCheck >= COST_CHECK_MS) {
				lastCostCheck = now;
				costUSD = (await deps.measureCostUSD(taskId)) ?? costUSD;
				if (costUSD !== null && costUSD > limits.maxCostUSD) {
					return finish({
						kind: "cost_cap",
						detail: `$${costUSD.toFixed(2)} spent, over the $${limits.maxCostUSD} cap`,
					});
				}
			}
			if (worktreePath) {
				toolUse = (await deps.signals.countToolUse(agentId, worktreePath)) ?? toolUse;
				if ((await deps.signals.hasImageRejection(agentId, worktreePath)) === true) {
					sawImageRejection = true;
					return finish({ kind: "image_rejection", detail: "the model rejected an image (no images support)" });
				}
				const loop = await deps.signals.findToolCallLoop(agentId, worktreePath);
				if (loop) {
					return finish({
						kind: "tool_loop",
						detail: `one tool call filled ${loop.count} of the last ${loop.of}: ${loop.call.slice(0, 160)}`,
					});
				}
				if (toolUse && toolUse.textual > 0 && toolUse.native === 0) {
					return finish({
						kind: "text_tool_calls",
						detail: `${toolUse.textual} tool call(s) written as text, none native`,
					});
				}
			}
			if (session?.state === "failed") {
				return finish({
					kind: "session_failed",
					detail: `the session failed (${session.reviewReason ?? "no reason"})`,
				});
			}
			const progressAt = Math.max(
				session?.lastHookAt ?? 0,
				session?.stateChangedAt ?? 0,
				(await deps.readLatestWriteAt(input.repoPath)) ?? 0,
			);
			if (progressAt > lastProgressAt) {
				lastProgressAt = progressAt;
			}
			if (worktreePath) {
				const failure = await deps.probe({
					agentId,
					worktreePath,
					providerId: combination.provider,
					runStartedAt: session?.startedAt ?? runStartedAt,
					kanbanProgressAt: lastProgressAt,
					stallMin: limits.stallMin,
					now,
				});
				if (failure) {
					return finish(failure);
				}
			}
			if (now - runStartedAt >= limits.startMin * 60_000) {
				const started = worktreePath ? await deps.signals.hasStartedTurn(agentId, worktreePath) : null;
				if (started === false) {
					return finish({
						kind: "no_session",
						detail: `no turn started in ${limits.startMin} min (a sign-in or trust screen takes the prompt as input)`,
					});
				}
			}
			const inReview = columnId === "review" && session !== null && session.state !== "running";
			if (inReview && isReviewSettled(session, now, limits.reviewSettleMs)) {
				turnEnded = true;
				costUSD = (await deps.measureCostUSD(taskId)) ?? costUSD;
				const checks = await checkVetTask(input.task, input.repoPath, deps.checks);
				return finish(null, checks);
			}
			if (session?.state === "running" && now - lastProgressAt >= limits.stallMin * 60_000) {
				return finish({
					kind: "silent_stall",
					detail: `running with no progress for ${minutes(now - lastProgressAt)} min (no hook, no write)`,
				});
			}
			if (now - runStartedAt >= limits.maxMin * 60_000) {
				return finish({ kind: "time_cap", detail: `no finished turn after ${limits.maxMin} min` });
			}
		}
	} finally {
		await deps.board.discardTask(taskId).catch((error: unknown) => {
			deps.log(`vet ${input.runId}: discarding card ${taskId} failed: ${String(error)}`);
		});
	}
}
