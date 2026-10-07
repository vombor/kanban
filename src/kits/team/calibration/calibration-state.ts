// A calibration's resumable state (`<dir>/state.json`) and its results (`results.json`, `results.md`), in the legacy
// kit's shapes: the watchdog and prune-done read the run ids from state.json (src/pipeline/watchdog/workspace-data.ts),
// and the orchestrator judges results.md. `version` and `finishedAt` are new: a state with `finishedAt` is done, so
// prune-done may delete its cards (the legacy kit read that from results.md plus its log).
//
// Ported from archive/devteam-kit:qa/calibrate.mjs@94247a7 (st.runs, finish, writeResults).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CalibrationPaths } from "../../../state/kanban-home";
import type { CalibrationRunPlan, CalibrationSpec } from "./calibration-spec";

export const CALIBRATION_STATE_VERSION = 1;

export interface CalibrationRunState {
	/** The calibration card (unset while the run waits for its wave, or when it could not start). */
	id?: string;
	outDir?: string;
	scratch?: string;
	base?: string;
	startedAt?: number;
	nudges?: number;
	lastNudge?: number;
	lastCostCheck?: number;
	/** The first reason verdict.json was unusable (a judging fact: an invalid verdict disqualifies). */
	badVerdict?: string;
	/** Set once the run is finished (ISO time). */
	done?: string;
	wallMin?: number;
	/** PASS | FAIL | STALLED as the QA model wrote it, else DNF. */
	verdict?: string;
	why?: string;
	scores?: Record<string, number | null> | null;
	blocking?: string[];
	visual?: { status: string; artifacts: string[]; consoleErrors: number } | null;
	notes?: string;
	costUSD?: number | null;
	tokens?: { in: number; out: number; cacheRead: number } | null;
}

export interface CalibrationState {
	version?: number;
	runs: Record<string, CalibrationRunState>;
	/** When every run had finished (ISO time); null while running. */
	finishedAt?: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function writeFileAtomic(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, text);
	await rename(temporary, path);
}

/** The state file, or an empty state. A file that exists but can't be read is an error (never overwrite a run). */
export async function readCalibrationState(path: string): Promise<CalibrationState> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { version: CALIBRATION_STATE_VERSION, runs: {}, finishedAt: null };
		}
		throw error;
	}
	const parsed: unknown = JSON.parse(text);
	if (!isPlainObject(parsed) || !isPlainObject(parsed.runs ?? {})) {
		throw new Error(`${path} is not a calibration state (no "runs" object)`);
	}
	return { ...(parsed as unknown as CalibrationState), runs: (parsed.runs ?? {}) as CalibrationState["runs"] };
}

export async function writeCalibrationState(path: string, state: CalibrationState): Promise<void> {
	await writeFileAtomic(path, `${JSON.stringify({ ...state, version: CALIBRATION_STATE_VERSION }, null, 2)}\n`);
}

function cell(value: string): string {
	return value.replace(/\|/gu, "/");
}

function describeRun(run: CalibrationRunState | undefined): string {
	return run?.verdict ?? (run?.id ? "running" : "pending");
}

export function formatCalibrationResults(input: {
	spec: CalibrationSpec;
	runs: CalibrationRunPlan[];
	state: CalibrationState;
	outboxRoot: string;
	now: Date;
}): string {
	const rows = input.runs.map(({ key, set, model }) => {
		const run = input.state.runs[key];
		const scores = run?.scores
			? Object.values(run.scores)
					.map((score) => score ?? "-")
					.join("/")
			: "-";
		const cost = run?.costUSD === undefined || run.costUSD === null ? "-" : `$${run.costUSD.toFixed(2)}`;
		const notes = cell(run?.notes || run?.why || "").slice(0, 120);
		return `| ${set.id} | ${set.expect ?? "?"} | ${model.key} | ${describeRun(run)} | ${scores} | ${run?.visual?.status ?? "-"} | ${run?.blocking?.length ?? "-"} | ${run?.wallMin ?? "-"} | ${cost} | ${notes} |`;
	});
	return [
		`# QA calibration ${input.spec.name} (${input.now.toISOString().slice(0, 16)}Z)`,
		"",
		`Scores: spec/correctness/tests/ux/code/process. Blocking lists and artifacts: results.json and ${input.outboxRoot}`,
		"",
		"| set | expected | QA model | verdict | scores | visual | #blocking | min | cost | notes |",
		"|---|---|---|---|---|---|---|---|---|---|",
		...rows,
		"",
	].join("\n");
}

export async function writeCalibrationResults(input: {
	paths: CalibrationPaths;
	spec: CalibrationSpec;
	runs: CalibrationRunPlan[];
	state: CalibrationState;
	outboxRoot: string;
	now: Date;
}): Promise<void> {
	await writeFileAtomic(
		input.paths.resultsJson,
		`${JSON.stringify({ spec: input.spec, runs: input.state.runs }, null, 2)}\n`,
	);
	await writeFileAtomic(input.paths.resultsMd, formatCalibrationResults(input));
}
