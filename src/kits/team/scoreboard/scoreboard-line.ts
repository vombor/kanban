// One scoreboard line per QA verdict (or pipeline outcome) for a dev card, appended to the workspace's
// `data/<id>/scoreboard.jsonl`. The format is the legacy kit's, so foo's existing scoreboard keeps reading the same:
// `"source":"qa"` lines are QA rounds; any other source (the legacy kit wrote "autoland", Kanban's pipeline writes
// "pipeline") is an outcome QA can't see (CONFLICT, ESCALATED, AGENT_ERROR, HUMAN_APPROVED).
//
// Ported from archive/devteam-kit:bench/record-verdict.cjs@5266ea62.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { RuntimeAgentId } from "../../../core/api-contract";
import type { CardMetrics, CardMetricsTotals } from "../bench/card-metrics";

export const SCORE_DIMENSIONS = ["spec", "correctness", "tests", "ux", "code", "process"] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];
export type Scores = Record<ScoreDimension, number | null>;

export const QA_VERDICTS = ["PASS", "FAIL", "STALLED", "DNF"] as const;
export const OUTCOME_VERDICTS = ["CONFLICT", "ESCALATED", "AGENT_ERROR", "HUMAN_APPROVED"] as const;
export type QaVerdictName = (typeof QA_VERDICTS)[number];
export type OutcomeVerdictName = (typeof OUTCOME_VERDICTS)[number];
export type ScoreboardSource = "qa" | "pipeline" | "autoland";

export interface ScoreboardVisual {
	status: "ok" | "blocked" | "n/a";
	artifacts: string[];
	consoleErrors: number;
}

export interface ScoreboardLine {
	ts: string;
	devId: string;
	title: string | null;
	round: number;
	/** null = an ungraded QA round. */
	verdict: QaVerdictName | OutcomeVerdictName | null;
	source: ScoreboardSource;
	agent: RuntimeAgentId | string | null;
	provider: string | null;
	model: string | null;
	modelSource: string | null;
	attribution: string | null;
	scores: Scores | null;
	blocking: string[];
	metrics: CardMetricsTotals | null;
	visual: ScoreboardVisual | null;
	benchmark: string | null;
	notes: string;
}

const BLOCKING_MAX = 200;
const NOTES_MAX = 400;

/** Validated and normalized scores (each dimension an integer 0-5 or null); throws on a bad value. */
export function normalizeScores(value: unknown): Scores | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error("scores must be an object or null");
	}
	const input = value as Record<string, unknown>;
	const scores = Object.fromEntries(
		SCORE_DIMENSIONS.map((dimension) => [dimension, input[dimension] ?? null]),
	) as Record<ScoreDimension, unknown>;
	for (const [dimension, score] of Object.entries(scores)) {
		if (score !== null && !(Number.isInteger(score) && (score as number) >= 0 && (score as number) <= 5)) {
			throw new Error(`score ${dimension}=${String(score)} must be an integer 0-5 or null`);
		}
	}
	return scores as Scores;
}

export function normalizeVisual(value: unknown): ScoreboardVisual {
	const input = (value ?? { status: "n/a" }) as Partial<ScoreboardVisual>;
	if (input.status !== "ok" && input.status !== "blocked" && input.status !== "n/a") {
		throw new Error('visual.status must be "ok", "blocked" or "n/a"');
	}
	return {
		status: input.status,
		artifacts: Array.isArray(input.artifacts) ? input.artifacts.map(String) : [],
		consoleErrors: typeof input.consoleErrors === "number" ? input.consoleErrors : 0,
	};
}

export function isQaVerdict(value: unknown): value is QaVerdictName {
	return (QA_VERDICTS as readonly unknown[]).includes(value);
}

export function isOutcomeVerdict(value: unknown): value is OutcomeVerdictName {
	return (OUTCOME_VERDICTS as readonly unknown[]).includes(value);
}

export interface ScoreboardLineInput {
	at: Date;
	round: number;
	verdict: ScoreboardLine["verdict"];
	source: Exclude<ScoreboardSource, "autoland">;
	scores?: Scores | null;
	blocking?: string[];
	visual?: ScoreboardVisual | null;
	benchmark?: string | null;
	notes?: string;
	/** Who built the round when the caller knows better than the session files (the pipeline's effective agent). */
	agent?: RuntimeAgentId | null;
}

/** The line for `metrics` (card-metrics.ts). Agent/provider/model come from the metrics' session files. */
export function buildScoreboardLine(metrics: CardMetrics, input: ScoreboardLineInput): ScoreboardLine {
	if (!Number.isInteger(input.round) || input.round < 1) {
		throw new Error("round must be a positive integer");
	}
	const allowed = input.source === "qa" ? isQaVerdict : isOutcomeVerdict;
	if (!(input.source === "qa" && input.verdict === null) && !allowed(input.verdict)) {
		const names = input.source === "qa" ? QA_VERDICTS : OUTCOME_VERDICTS;
		throw new Error(`verdict must be one of ${names.join("|")} for source ${input.source}`);
	}
	return {
		ts: input.at.toISOString(),
		devId: metrics.devId,
		title: metrics.title,
		round: input.round,
		verdict: input.verdict,
		source: input.source,
		agent: metrics.agent ?? input.agent ?? null,
		provider: metrics.provider,
		model: metrics.model,
		modelSource: metrics.modelSource,
		attribution: metrics.attribution,
		scores: input.scores ?? null,
		blocking: (input.blocking ?? []).map((entry) => String(entry).slice(0, BLOCKING_MAX)),
		metrics: metrics.metrics,
		visual: input.visual ?? { status: "n/a", artifacts: [], consoleErrors: 0 },
		benchmark: input.benchmark ?? null,
		notes: String(input.notes ?? "").slice(0, NOTES_MAX),
	};
}

export async function appendScoreboardLine(path: string, line: ScoreboardLine): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(line)}\n`);
}

export interface ScoreboardFile {
	/** Non-empty lines read. */
	lines: number;
	/** 1-based numbers of unparseable lines. */
	bad: number[];
	/** De-duplicated rows, oldest first. */
	rows: ScoreboardLine[];
}

/**
 * Reads a scoreboard.jsonl. Duplicate lines for the same (devId, round, benchmark, source) keep only the last one (a
 * re-run QA); outcome lines are also keyed by verdict.
 */
export function parseScoreboard(text: string): ScoreboardFile {
	const raw = text.split("\n").filter((line) => line.trim());
	const bad: number[] = [];
	const byKey = new Map<string, ScoreboardLine>();
	raw.forEach((line, index) => {
		try {
			const row = JSON.parse(line) as ScoreboardLine;
			const source = row.source ?? "qa";
			byKey.set(
				`${row.devId}|${row.round}|${row.benchmark ?? ""}|${source}${source === "qa" ? "" : `|${row.verdict}`}`,
				row,
			);
		} catch {
			bad.push(index + 1);
		}
	});
	const rows = [...byKey.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
	return { lines: raw.length, bad, rows };
}

export async function readScoreboard(path: string): Promise<ScoreboardFile> {
	return parseScoreboard(await readFile(path, "utf8").catch(() => ""));
}
