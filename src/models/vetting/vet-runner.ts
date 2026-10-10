// `kanban models vet`'s runner (docs/team/MODELS.md "Vetting"): one throwaway smoke-test card for one agent +
// provider + model and role, driven through the running server like `kanban bench calibrate` (create, start, watch,
// discard), with role `calibration` so the pipeline, auto-review and the watchdog's stall checks leave it alone.
//
// It watches the run with Kanban's failure detectors and stops at the first one: the agent not signed in, no turn
// started (`no_session`: a sign-in screen takes the prompt as input), an image rejection, tool calls written as text,
// a tool-call loop (the same finished call filling TOOL_LOOP_RULE's share of the last calls), the agent-specific
// stalls (vet-probe.ts: Cline's silent stall, hung request, context overflow, provider error), a session that failed,
// no progress for `stallMin` (only where the probe can't read the agent), the time cap and the cost cap. A provider
// timeout on a local provider is retried PROVIDER_TIMEOUT_RETRIES times before it counts. A turn that ends (Review,
// settled) is then checked against the task (vet-tasks.ts). The card is always discarded, never landed.
//
// Before the card is created, the run waits for its provider's capacity (`models.providerCapacity`, counted over every
// project's In Progress cards like the QA gate's, src/pipeline/provider-capacity.ts) for up to `capacityWaitMin`:
// a third Lemonade model would evict another project's, and that project's next request evicts the vet model (issue
// #25: five of 17 runs got only "No model loaded"). A run that ends on a harness or environment failure, the
// capacity wait included, is `inconclusive`: it says nothing about the model.
//
// The result is a report and a proposed registry entry (vet-report.ts). It never edits the registry: the Kanban
// orchestrator commits the proposal to models/vetted.json.
import type { RuntimeAgentId, RuntimeTaskAgentSettings, RuntimeTaskSessionSummary } from "../../core/api-contract";
import type { ProviderCapacityHold } from "../../pipeline/provider-capacity";
import { buildProviderRetryPrompt } from "../../pipeline/recovery-prompts";
import { isReviewSettled } from "../../terminal/review-settle";
import type { ModelCombination, VettingRole } from "../vetted-registry";
import type { VetFailure, VetProbeInput, VetProbeVerdict } from "./vet-probe";
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
	/** How long the run waits for its provider's capacity before it gives up (inconclusive). */
	capacityWaitMin: number;
}

export const DEFAULT_VET_LIMITS: VetLimits = {
	maxMin: 30,
	maxCostUSD: 2,
	stallMin: 8,
	startMin: 4,
	pollSec: 10,
	reviewSettleMs: 12_000,
	capacityWaitMin: 30,
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
		/** Types a message into the card's agent (deliverTaskInput, with delivery confirmation). */
		deliverInput: (taskId: string, text: string) => Promise<{ ok: boolean; error?: string | null }>;
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
		/** The most repeated finished tool call among the last `last` (findRepeatedToolCall). */
		findToolCallLoop: (
			agentId: RuntimeAgentId,
			workspacePath: string,
			last: number,
		) => Promise<{ count: number; of: number; call: string } | null>;
	};
	/**
	 * Who holds the combination's provider at its `models.providerCapacity` limit (every project's In Progress
	 * cards), null when the model may run now. Asked before the card is created.
	 */
	findCapacityHold: (combination: ModelCombination) => Promise<ProviderCapacityHold | null>;
	/** The agent-specific failure detectors (vet-probe.ts); null where they can't read the agent. */
	probe: (input: VetProbeInput) => Promise<VetProbeVerdict | null>;
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

/** `inconclusive`: a harness or environment failure (`failure.harness`), which says nothing about the model. */
export type VetOutcome = "passed" | "failed" | "inconclusive";

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
/**
 * A loop is one finished tool call filling `minRepeats` of the last `window` calls. The first runs (2026-10-09) were
 * failed as loops after one or two calls ("1 of the last 1"), since any most-repeated call counted.
 */
export const TOOL_LOOP_RULE = { window: 4, minRepeats: 3 };
/** Retries of a local provider's timeout (a model still loading) before it counts as `provider_timeout`. */
export const PROVIDER_TIMEOUT_RETRIES = 2;
/** How long a retry may take to show up in the session before the same error counts again. */
const RETRY_PICKUP_MS = 120_000;

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

/** "lemonade holds 2 of 2 model(s): d2222 (GLM-4.7-Flash-GGUF), 1 card(s) of other projects". */
export function describeCapacityHold(hold: ProviderCapacityHold): string {
	const others = hold.otherWorkspaceHolders > 0 ? [`${hold.otherWorkspaceHolders} card(s) of other projects`] : [];
	return `${hold.provider} holds ${hold.loadedModels} of ${hold.maxLoadedModels} model(s): ${[...hold.holders, ...others].join(", ")}`;
}

function toOutcome(failure: VetFailure | null, checks: VetCheck[]): VetOutcome {
	if (failure?.harness) {
		return "inconclusive";
	}
	return failure === null && checks.every((check) => check.ok) ? "passed" : "failed";
}

export async function runVet(input: VetRunInput, deps: VetRunnerDeps): Promise<VetRunResult> {
	const { combination, limits } = input;
	const agentId = combination.agentId;
	let startedAt = deps.now();
	const base = { runId: input.runId, combination, role: input.role };
	let taskId: string | null = null;
	let costUSD: number | null = null;
	let toolUse: VetRunResult["toolUse"] = null;
	let turnEnded = false;
	let sawImageRejection = false;
	const finish = (failure: VetFailure | null, checks: VetCheck[] = []): VetRunResult => ({
		...base,
		outcome: toOutcome(failure, checks),
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
		return finish({ kind: "sign_in", detail: `${agentId} has no login it can start a run with`, harness: true });
	}
	let lastCapacityHold: string | null = null;
	for (;;) {
		const hold = await deps.findCapacityHold(combination);
		if (!hold) {
			break;
		}
		const holders = describeCapacityHold(hold);
		if (deps.now() - startedAt >= limits.capacityWaitMin * 60_000) {
			return finish({
				kind: "capacity",
				detail: `still no room after ${limits.capacityWaitMin} min (models.providerCapacity): ${holders}`,
				harness: true,
			});
		}
		if (holders !== lastCapacityHold) {
			lastCapacityHold = holders;
			deps.log(`vet ${input.runId}: waiting for capacity: ${holders}`);
		}
		await deps.sleep(limits.pollSec * 1000);
	}
	if (lastCapacityHold !== null) {
		deps.log(`vet ${input.runId}: ${combination.provider} has room now`);
		// The run's time is the card's, not the wait's.
		startedAt = deps.now();
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
		let lastHold: string | null = null;
		const timeoutRetries: Array<{ occurrence: string | undefined; at: number }> = [];
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
				const loop = await deps.signals.findToolCallLoop(agentId, worktreePath, TOOL_LOOP_RULE.window);
				if (loop && loop.count >= TOOL_LOOP_RULE.minRepeats) {
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
					harness: true,
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
			const verdict = worktreePath
				? await deps.probe({
						agentId,
						worktreePath,
						providerId: combination.provider,
						model: combination.model,
						agentPid: session?.pid ?? null,
						runStartedAt: session?.startedAt ?? runStartedAt,
						kanbanProgressAt: lastProgressAt,
						stallMin: limits.stallMin,
						now,
					})
				: null;
			if (verdict && verdict.hold !== lastHold) {
				lastHold = verdict.hold;
				if (verdict.hold) {
					deps.log(`vet ${input.runId}: not judging silence: ${verdict.hold}`);
				}
			}
			const failure = verdict?.failure ?? null;
			if (failure?.kind === "provider_timeout") {
				const last = timeoutRetries.at(-1);
				if (last && last.occurrence === failure.occurrence && now - last.at < RETRY_PICKUP_MS) {
					continue;
				}
				if (timeoutRetries.length >= PROVIDER_TIMEOUT_RETRIES) {
					return finish({
						...failure,
						detail: `${failure.detail} (still after ${timeoutRetries.length} retries)`,
					});
				}
				timeoutRetries.push({ occurrence: failure.occurrence, at: now });
				const delivery = await deps.board.deliverInput(taskId, buildProviderRetryPrompt(failure.detail));
				deps.log(
					`vet ${input.runId}: ${failure.detail}; retry ${timeoutRetries.length}/${PROVIDER_TIMEOUT_RETRIES} ${delivery.ok ? "sent" : `not delivered (${delivery.error ?? "no reason"})`}`,
				);
				if (!delivery.ok) {
					return finish({ ...failure, detail: `${failure.detail} (the retry wasn't delivered)` });
				}
				continue;
			}
			if (failure) {
				return finish(failure);
			}
			if (now - runStartedAt >= limits.startMin * 60_000) {
				const started = worktreePath ? await deps.signals.hasStartedTurn(agentId, worktreePath) : null;
				if (started === false) {
					return finish({
						kind: "no_session",
						detail: `no turn started in ${limits.startMin} min (a sign-in or trust screen takes the prompt as input)`,
						harness: true,
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
			// Where the probe reads the agent, its silent-stall reader owns the silence (model loading, first reply, tools).
			if (!verdict && session?.state === "running" && now - lastProgressAt >= limits.stallMin * 60_000) {
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
