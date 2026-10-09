// The team kit's `calibration` feature: runs a calibration spec (calibration-spec.ts) to the end, LLM-free. It
// creates and starts one `role: "calibration"` card per set × model, a wave of `parallel` runs at a time, waits,
// nudges a card that stops without a verdict, ends runs that can't finish (DNF), stops their scratch servers, moves
// each finished card to Done and writes results.json + results.md. When every run is done it asks the watchdog to wake
// the orchestrator, which judges the verdicts against the known answers (`<dir>/README.md` says how).
//
// It runs as its own detached process (`kanban bench calibrate`), because a calibration lasts hours and must survive a
// pipeline reload; state.json makes it resumable (a restarted runner picks up the cards it started). It changes the
// board only through the Kanban server, like the CLI. The pipeline never QAs, lands or reworks calibration cards
// (their role), the watchdog opens no stall TRIAGE for them, and verdicts are never written to the scoreboard.
//
// Ported from archive/devteam-kit:qa/calibrate.mjs@94247a7. Rules kept, each with a test in
// test/runtime/kits/team/calibration-runner.test.ts:
// - one set at a time across all models, so the models review the same work under the same load (956e9e7);
// - no new wave while the watchdog's PID pressure flag is up, no nudge during a brownout (cdcb87f);
// - a verdict counts once the session stopped; a card moved to Done or deleted by hand ends the run;
// - a run past `timeoutMin`, past `maxCostUSD` or in a tool-call loop (`loopRepeats` of the last 60 calls) is DNF
//   (ce7b672: Nova 2 Lite re-ran one command 334 times, $64.84);
// - a stopped card without a verdict is nudged once a minute at most, `maxNudges` times (8ffce60); an unusable
//   verdict.json is quoted in the nudge and kept as `badVerdict` for the judge (666a084);
// - no native tool call after 2 nudges = the serving stack can't do tool calls for that model: DNF (94247a7);
// - no run on an agent that is signed out (60c5538; a rerun retries it), and DNF for one that never started a turn in
//   10 min (de83bf8);
// - a stop on the model's "no images" rejection gets the pipeline's image recovery (clear + the run prompt resent with
//   the no-images note) instead of "continue", and the same rejection right after it is DNF "model rejects images"
//   (issue #7: Bedrock's OpenAI models spent all 6 nudges resending the image-poisoned history);
// - the card's session state wins; the agent's own session file decides when Kanban has no summary (b5744b3).
import { join } from "node:path";

import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeTaskAgentSettings,
	RuntimeWorkspaceStateResponse,
} from "../../../core/api-contract";
import {
	buildQaVerdictFixHint,
	getQaVerdictPath,
	type QaVerdict,
	type QaVerdictRead,
} from "../../../pipeline/qa-verdict";
import { buildClearedPrematurePrompt, CLEAR_SETTLE_MS } from "../../../pipeline/recovery-prompts";
import type { CalibrationPaths } from "../../../state/kanban-home";
import type { AgentRunSignals } from "../../../terminal/agent-run-signals";
import { getAgentRecoveryProfile } from "../../../terminal/agent-session-adapters";
import type { QaPromptParts } from "../../policy";
import { buildCalibrationCardTitle, buildCalibrationPrompt } from "./calibration-prompt";
import {
	type CalibrationRunPlan,
	type CalibrationSpec,
	getCalibrationSetRef,
	listCalibrationRuns,
} from "./calibration-spec";
import {
	type CalibrationRunState,
	type CalibrationState,
	readCalibrationState,
	writeCalibrationResults,
	writeCalibrationState,
} from "./calibration-state";

export const CALIBRATION_POLL_MS = 30_000;
const PRESSURE_RETRY_MS = 60_000;
const NUDGE_GAP_MS = 60_000;
const COST_CHECK_MS = 300_000;
const TURN_START_GRACE_MS = 600_000;
const TOOL_LOOP_WINDOW = 60;
/** Nudges after which a run with no native tool call is DNF. */
const NATIVE_TOOL_NUDGES = 2;
/** The DNF reason of a run whose model rejects images even after the image recovery. */
export const IMAGE_REJECTION_REASON = "model rejects images";

export type CalibrationBoardState = Pick<RuntimeWorkspaceStateResponse, "board" | "sessions">;

export interface CalibrationCardInput {
	title: string;
	prompt: string;
	agentId: RuntimeAgentId;
	agentSettings?: RuntimeTaskAgentSettings;
}

/** The Kanban server, for one workspace (`kanban task …` over tRPC in the CLI). */
export interface CalibrationBoard {
	read: () => Promise<CalibrationBoardState>;
	/** Creates the card in Backlog (role `calibration`, never auto-reviewed) and returns its id. */
	createTask: (input: CalibrationCardInput) => Promise<string>;
	startTask: (taskId: string) => Promise<void>;
	/** The Done workflow; the card's worktree is discarded (QA never edits, and there is nothing to land). */
	finishTask: (taskId: string) => Promise<void>;
	deliverInput: (taskId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface CalibrationRunMetrics {
	costUSD: number | null;
	tokens: { in: number; out: number; cacheRead: number } | null;
}

export interface CalibrationDependencies {
	board: CalibrationBoard;
	signals: AgentRunSignals;
	/** The dev card's prompt (live board, else a board backup), or null. */
	readDevPrompt: (taskId: string) => Promise<string | null>;
	/** Points `ref` at `target` in the project repo. */
	updateRef: (ref: string, target: string) => Promise<void>;
	/** Empties a run's outbox before its card starts. */
	resetOutbox: (dir: string) => Promise<void>;
	readVerdict: (outboxDir: string) => Promise<QaVerdictRead>;
	measure: (taskId: string) => Promise<CalibrationRunMetrics | null>;
	stopScratchProcesses: (dirs: string[]) => Promise<number>;
	/** The watchdog's PID flags (`<home>/run/pid-pressure`, `pid-brownout`). */
	readPidPressure: () => Promise<{ pressure: boolean; brownout: boolean }>;
	/** The card's worktree when Kanban has no session summary with its path. */
	findWorktreePath: (taskId: string) => Promise<string | null>;
	/** Queues an orchestrator wake (`kanban orchestrator wake`). */
	wakeOrchestrator: (issue: string) => Promise<void>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	log: (message: string) => void;
}

export interface CalibrationRunInput {
	spec: CalibrationSpec;
	paths: CalibrationPaths;
	repoPath: string;
	/** `<pipeline.qa.outboxRoot>/cal/<name>`: one outbox per run below it. */
	outboxRoot: string;
	/** `pipeline.qa.scratchRoot`: scratch copies are `<root>/cal-<name>-<run key>`. */
	scratchRoot: string;
	/** The kit's prompt parts for a model's rule names. */
	promptParts: (rules: string[]) => QaPromptParts;
	kanbanHome: string;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function columnOf(state: CalibrationBoardState, taskId: string): RuntimeBoardColumnId | null {
	return state.board.columns.find((column) => column.cards.some((card) => card.id === taskId))?.id ?? null;
}

function cardOf(state: CalibrationBoardState, taskId: string): RuntimeBoardCard | null {
	for (const column of state.board.columns) {
		const card = column.cards.find((entry) => entry.id === taskId);
		if (card) {
			return card;
		}
	}
	return null;
}

function toAgentSettings(run: CalibrationRunPlan): RuntimeTaskAgentSettings | undefined {
	const { provider, model } = run.model;
	if (!provider && !model) {
		return undefined;
	}
	return { ...(provider ? { providerId: provider } : {}), ...(model ? { modelId: model } : {}) };
}

export async function runCalibration(
	input: CalibrationRunInput,
	deps: CalibrationDependencies,
): Promise<CalibrationState> {
	const { spec, paths } = input;
	const runs = listCalibrationRuns(spec);
	const state = await readCalibrationState(paths.state);
	state.finishedAt = null;
	// A run not started because its agent was signed out says "sign it in, then rerun": this is the rerun.
	for (const [key, entry] of Object.entries(state.runs)) {
		if (entry.signedOut && !entry.id) {
			delete state.runs[key];
		}
	}
	const timeoutMs = spec.timeoutMin * 60_000;

	const save = async (): Promise<void> => {
		await writeCalibrationState(paths.state, state);
	};
	const writeResults = async (): Promise<void> => {
		await writeCalibrationResults({
			paths,
			spec,
			runs,
			state,
			outboxRoot: input.outboxRoot,
			now: new Date(deps.now()),
		});
	};

	const createRun = async (run: CalibrationRunPlan): Promise<CalibrationRunState> => {
		const devPrompt = await deps.readDevPrompt(run.set.fromCard);
		if (!devPrompt) {
			throw new Error(`no prompt for card ${run.set.fromCard}`);
		}
		const ref = getCalibrationSetRef(spec, run.set);
		await deps.updateRef(ref, run.set.ref);
		const outDir = join(input.outboxRoot, run.key);
		const scratch = join(input.scratchRoot, `cal-${spec.name}-${run.key}`);
		await deps.resetOutbox(outDir);
		const id = await deps.board.createTask({
			title: buildCalibrationCardTitle(run),
			prompt: buildCalibrationPrompt({
				spec,
				run,
				devPrompt,
				repoPath: input.repoPath,
				snapshotRef: ref,
				scratchDir: scratch,
				outboxDir: outDir,
				parts: input.promptParts(run.model.rules),
				kanbanHome: input.kanbanHome,
			}),
			agentId: run.model.agent,
			agentSettings: toAgentSettings(run),
		});
		try {
			await deps.board.startTask(id);
		} catch (error) {
			deps.log(`${run.key}: start returned ${toErrorMessage(error)}`);
		}
		return { id, outDir, scratch, base: run.set.base, startedAt: deps.now(), nudges: 0 };
	};

	const finish = async (
		run: CalibrationRunPlan,
		entry: CalibrationRunState,
		verdict: QaVerdict | null,
		why: string,
	): Promise<void> => {
		const now = deps.now();
		entry.done = new Date(now).toISOString();
		entry.wallMin = Math.round((now - (entry.startedAt ?? now)) / 6000) / 10;
		entry.verdict = verdict?.verdict ?? "DNF";
		entry.why = why;
		entry.scores = verdict?.scores ?? null;
		entry.blocking = verdict?.blocking ?? [];
		entry.visual = verdict?.visual ?? null;
		entry.notes = verdict?.notes ?? "";
		const metrics = entry.id ? await deps.measure(entry.id).catch(() => null) : null;
		entry.costUSD = metrics?.costUSD ?? null;
		entry.tokens = metrics?.tokens ?? null;
		const scratch = entry.scratch ?? "";
		const stopped = scratch
			? await deps.stopScratchProcesses([scratch, `${scratch}-${entry.base ?? ""}`]).catch(() => 0)
			: 0;
		if (entry.id) {
			await deps.board.finishTask(entry.id).catch((error: unknown) => {
				deps.log(`${run.key}: moving card ${entry.id} to Done failed: ${toErrorMessage(error)}`);
			});
		}
		deps.log(
			`${run.key}: ${entry.verdict} (${why}) in ${entry.wallMin} min; stopped ${stopped} scratch process(es); card ${entry.id ?? "-"} → Done`,
		);
		await save();
		await writeResults();
	};

	const markNotStarted = async (run: CalibrationRunPlan, why: string, signedOut = false): Promise<void> => {
		state.runs[run.key] = {
			done: new Date(deps.now()).toISOString(),
			verdict: "DNF",
			why,
			...(signedOut ? { signedOut } : {}),
		};
		await save();
	};

	const startWave = async (wave: CalibrationRunPlan[]): Promise<void> => {
		for (const run of wave) {
			if (state.runs[run.key]?.done || state.runs[run.key]?.id) {
				continue;
			}
			if ((await deps.signals.isSignedIn(run.model.agent)) === false) {
				await markNotStarted(
					run,
					`${run.model.agent} is signed out (no login in its config or env); sign it in, then rerun`,
					true,
				);
				deps.log(`${run.key}: not started, ${run.model.agent} is signed out`);
				continue;
			}
			try {
				state.runs[run.key] = await createRun(run);
				deps.log(
					`${run.key}: card ${state.runs[run.key]?.id} started (${run.model.agent} ${run.model.model ?? ""})`.trimEnd(),
				);
			} catch (error) {
				await markNotStarted(run, `could not start: ${toErrorMessage(error)}`);
				deps.log(`${run.key}: ${toErrorMessage(error)}`);
				continue;
			}
			await save();
		}
	};

	const isRunning = async (
		run: CalibrationRunPlan,
		board: CalibrationBoardState,
		taskId: string,
		workspacePath: string | null,
	): Promise<boolean> => {
		const summary = board.sessions[taskId];
		if (summary) {
			return summary.state === "running";
		}
		// Kanban may have no summary for a card (10/05, Cline cards from ~10:01): then the agent's session file decides.
		return workspacePath ? (await deps.signals.isSessionRunning(run.model.agent, workspacePath)) === true : false;
	};

	const finishIfTimedOut = async (
		run: CalibrationRunPlan,
		entry: CalibrationRunState,
		verdict: QaVerdict | null,
		note = "",
	): Promise<boolean> => {
		if (deps.now() - (entry.startedAt ?? deps.now()) <= timeoutMs) {
			return false;
		}
		await finish(run, entry, verdict, `timed out after ${spec.timeoutMin} min${note}`);
		return true;
	};

	/** A started run while the board can't be read: only the timeout applies (and a verdict, if one is written). */
	const checkRunBlind = async (run: CalibrationRunPlan, entry: CalibrationRunState): Promise<void> => {
		const read = await deps.readVerdict(entry.outDir ?? join(input.outboxRoot, run.key));
		await finishIfTimedOut(run, entry, read.kind === "ok" ? read.verdict : null, " (board unreadable)");
	};

	/**
	 * The model rejected an image, which stays in its history and fails every later request, so "continue" can't help:
	 * the pipeline's image recovery (clear the conversation, resend the run prompt with the no-images or image-size note). A
	 * rejection right after one, or with no nudge left, ends the run DNF.
	 */
	const recoverFromImageRejection = async (
		run: CalibrationRunPlan,
		entry: CalibrationRunState,
		board: CalibrationBoardState,
		taskId: string,
		tooLarge: boolean,
	): Promise<void> => {
		const nudges = entry.nudges ?? 0;
		const clear = getAgentRecoveryProfile(run.model.agent).clearContextCommand;
		const prompt = cardOf(board, taskId)?.prompt ?? "";
		if (entry.imageRecoverySent) {
			await finish(run, entry, null, IMAGE_REJECTION_REASON);
			return;
		}
		if (nudges >= spec.maxNudges || !clear || !prompt) {
			const detail = !clear
				? `${run.model.agent} can't clear its conversation`
				: !prompt
					? "the card prompt can't be read to resend"
					: `after ${nudges} nudges`;
			await finish(run, entry, null, `${IMAGE_REJECTION_REASON} (${detail})`);
			return;
		}
		entry.nudges = nudges + 1;
		entry.lastNudge = deps.now();
		entry.imageRecoverySent = true;
		entry.imageRecoveries = (entry.imageRecoveries ?? 0) + 1;
		const deliver = async (text: string) =>
			await deps.board
				.deliverInput(taskId, text)
				.catch((error: unknown) => ({ ok: false, error: toErrorMessage(error) }));
		let sent = await deliver(clear);
		if (sent.ok) {
			await deps.sleep(CLEAR_SETTLE_MS);
			sent = await deliver(buildClearedPrematurePrompt(prompt, { kind: "no_images", text: "", tooLarge }));
		}
		deps.log(
			`${run.key}: ${IMAGE_REJECTION_REASON}; ${clear} + run prompt without images, nudge ${entry.nudges}/${spec.maxNudges} ${sent.ok ? "sent" : `FAILED (${sent.error ?? "not delivered"})`}`,
		);
		await save();
	};

	/** One look at a started, unfinished run. */
	const checkRun = async (
		run: CalibrationRunPlan,
		entry: CalibrationRunState,
		board: CalibrationBoardState,
		pid: { brownout: boolean },
	): Promise<void> => {
		const taskId = entry.id as string;
		const now = deps.now();
		const startedAt = entry.startedAt ?? now;
		const column = columnOf(board, taskId);
		const workspacePath = board.sessions[taskId]?.workspacePath ?? (await deps.findWorktreePath(taskId));
		const running = await isRunning(run, board, taskId, workspacePath);
		const outDir = entry.outDir ?? join(input.outboxRoot, run.key);
		const read = await deps.readVerdict(outDir);
		const verdict = read.kind === "ok" ? read.verdict : null;
		if (verdict && !running) {
			await finish(run, entry, verdict, "verdict written");
			return;
		}
		if (!column || column === "trash") {
			await finish(run, entry, verdict, `card ${column ?? "gone"}`);
			return;
		}
		if (await finishIfTimedOut(run, entry, verdict)) {
			return;
		}
		const agentId = run.model.agent;
		if (!verdict && workspacePath && now - startedAt > TURN_START_GRACE_MS) {
			if ((await deps.signals.hasStartedTurn(agentId, workspacePath)) === false) {
				await finish(run, entry, null, `${agentId} never started a turn in 10 min (no event log; signed out?)`);
				return;
			}
		}
		const loop =
			!verdict && workspacePath
				? await deps.signals.findToolCallLoop(agentId, workspacePath, TOOL_LOOP_WINDOW)
				: null;
		if (loop && loop.count >= spec.loopRepeats) {
			await finish(run, entry, null, `looping: ${loop.count} of the last ${loop.of} tool calls were ${loop.call}`);
			return;
		}
		if (!verdict && now - (entry.lastCostCheck ?? startedAt) > COST_CHECK_MS) {
			entry.lastCostCheck = now;
			const cost = (await deps.measure(taskId).catch(() => null))?.costUSD ?? null;
			if (cost !== null && cost > spec.maxCostUSD) {
				await finish(run, entry, null, `cost ${cost.toFixed(2)} passed the ${spec.maxCostUSD} cap`);
				return;
			}
		}
		if (running || column !== "review" || verdict || pid.brownout || now - (entry.lastNudge ?? 0) <= NUDGE_GAP_MS) {
			return;
		}
		const rejection = workspacePath ? await deps.signals.hasImageRejection(agentId, workspacePath) : null;
		if (rejection) {
			await recoverFromImageRejection(run, entry, board, taskId, rejection === "too_large");
			return;
		}
		entry.imageRecoverySent = false;
		const verdictPath = getQaVerdictPath(outDir);
		const bad = read.kind === "invalid" ? read.error : null;
		if (bad && !entry.badVerdict) {
			entry.badVerdict = bad;
		}
		const nudges = entry.nudges ?? 0;
		if (nudges >= NATIVE_TOOL_NUDGES && workspacePath) {
			const toolUse = await deps.signals.countToolUse(agentId, workspacePath);
			if (toolUse && toolUse.native === 0) {
				await finish(
					run,
					entry,
					null,
					`no native tool calls in ${toolUse.turns} turns (${toolUse.textual} written as text; serving chat template lacks tool calling?)`,
				);
				return;
			}
		}
		if (nudges >= spec.maxNudges) {
			await finish(
				run,
				entry,
				null,
				entry.badVerdict
					? `verdict.json unusable (${entry.badVerdict.slice(0, 80)}) after ${spec.maxNudges} nudges`
					: `stopped without a verdict after ${spec.maxNudges} nudges`,
			);
			return;
		}
		entry.nudges = nudges + 1;
		entry.lastNudge = now;
		const text = bad
			? `${buildQaVerdictFixHint(verdictPath, bad)} Then stop.`
			: `You stopped without writing ${verdictPath}. Continue the QA review from where you are and finish by writing that file exactly as step 6 describes (STALLED with the reason if you truly cannot finish).`;
		const sent = await deps.board
			.deliverInput(taskId, text)
			.catch((error: unknown) => ({ ok: false, error: toErrorMessage(error) }));
		deps.log(
			`${run.key}: ${bad ? `bad verdict.json (${bad.slice(0, 80)})` : "stopped without a verdict"}; nudge ${entry.nudges}/${spec.maxNudges} ${sent.ok ? "sent" : `FAILED (${sent.error ?? "not delivered"})`}`,
		);
		await save();
	};

	deps.log(`calibration ${spec.name}: ${runs.length} runs, ${spec.parallel} at a time (pid ${process.pid})`);
	await save();
	await writeResults();
	for (let index = 0; index < runs.length; index += spec.parallel) {
		const wave = runs.slice(index, index + spec.parallel);
		const unstarted = () => wave.some((run) => !state.runs[run.key]?.id && !state.runs[run.key]?.done);
		// PID pressure (the watchdog's flag): start no new wave until it clears.
		for (let held = false; unstarted() && (await deps.readPidPressure()).pressure; held = true) {
			if (!held) {
				deps.log("PID pressure: holding the next wave");
			}
			await deps.sleep(PRESSURE_RETRY_MS);
		}
		await startWave(wave);
		while (wave.some((run) => !state.runs[run.key]?.done)) {
			await deps.sleep(CALIBRATION_POLL_MS);
			// An unreadable board (the server down or restarting) still ends runs at their timeout; polls stay one apart.
			const board = await deps.board.read().catch((error: unknown) => {
				deps.log(`reading the board failed: ${toErrorMessage(error)}`);
				return null;
			});
			const pid = await deps.readPidPressure();
			for (const run of wave) {
				const entry = state.runs[run.key];
				if (!entry || entry.done || !entry.id) {
					continue;
				}
				await (board ? checkRun(run, entry, board, pid) : checkRunBlind(run, entry));
			}
		}
	}
	state.finishedAt = new Date(deps.now()).toISOString();
	await save();
	await writeResults();
	deps.log(`calibration ${spec.name}: all runs finished; results ${paths.resultsMd}`);
	await deps
		.wakeOrchestrator(
			`QA calibration ${spec.name} finished: judge it as ${paths.readme} says (results ${paths.resultsMd}).`,
		)
		.catch((error: unknown) => {
			deps.log(`waking the orchestrator failed: ${toErrorMessage(error)}`);
		});
	return state;
}
