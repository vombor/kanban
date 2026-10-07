// scoreboard.md from a workspace's scoreboard.jsonl: the team flow by agent/model, a leaderboard per model (one per
// benchmark plus one for regular dev cards) and the per-card table.
//
// Lines with a source other than "qa" (CONFLICT, ESCALATED, … from the pipeline or the legacy kit's autoland) are
// outcomes, not QA rounds: the leaderboards ignore them; the team-flow table and the per-card table show them.
// Team flow (dev cards, per agent/provider/model of the round): cards, first-round PASS (each card's first PASS/FAIL
//   QA verdict), avg rounds to PASS (QA PASS/FAIL rounds up to the first PASS, cards that passed), FAIL rounds,
//   conflicts, escalations, mean scores over scored QA rounds.
// Per model ("provider/model"):
//   cards           distinct cards
//   pass rate       cards whose latest verdict is PASS / cards with a latest verdict
//   1st-round pass  cards whose round-1 verdict is PASS / cards with a round-1 verdict
//   mean scores     mean of each 0-5 dimension over all scored rounds (n/a if none scored)
//   wall / active / cost / tool errors  from each card's LATEST round (metrics are cumulative per card, so summing
//                   rounds would double-count); cost "+n unpriced" = cards with unknown price
//
// Ported from archive/devteam-kit:bench/scoreboard.cjs@d2fb30fc.
import { SCORE_DIMENSIONS, type ScoreboardFile, type ScoreboardLine } from "./scoreboard-line";

const formatNumber = (value: number | null | undefined, digits = 1): string =>
	value === null || value === undefined || Number.isNaN(value) ? "–" : Number(value).toFixed(digits);
const percent = (part: number, whole: number): string =>
	whole ? `${Math.round((100 * part) / whole)}% (${part}/${whole})` : "–";
const mean = (values: number[]): number | null =>
	values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const modelKey = (row: ScoreboardLine): string =>
	row.model ? `${row.provider ?? "?"}/${row.model}` : `${row.agent ?? "?"} (model unknown)`;
const escapeCell = (value: unknown): string =>
	String(value ?? "")
		.replace(/\|/gu, "\\|")
		.replace(/\n/gu, " ");
const isQa = (row: ScoreboardLine): boolean => (row.source ?? "qa") === "qa";
const byRound = (a: ScoreboardLine, b: ScoreboardLine): number => a.round - b.round || (a.ts < b.ts ? -1 : 1);
const scoreMeans = (rows: ScoreboardLine[]): Record<string, number | null> =>
	Object.fromEntries(
		SCORE_DIMENSIONS.map((dimension) => [
			dimension,
			mean(rows.map((row) => row.scores?.[dimension]).filter((value): value is number => typeof value === "number")),
		]),
	);

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const name = key(item);
		groups.set(name, [...(groups.get(name) ?? []), item]);
	}
	return groups;
}

function teamFlow(rows: ScoreboardLine[]): string {
	const out = [
		...groupBy(
			rows,
			(row) => `${row.agent ?? "?"} · ${row.model ? `${row.provider ?? "?"}/${row.model}` : "model unknown"}`,
		),
	].map(([who, list]) => {
		const cards = groupBy(
			list.filter((row) => isQa(row) && (row.verdict === "PASS" || row.verdict === "FAIL")),
			(row) => row.devId,
		);
		for (const card of cards.values()) {
			card.sort(byRound);
		}
		const firsts = [...cards.values()].map((card) => card[0]).filter((row): row is ScoreboardLine => Boolean(row));
		const toPass = [...cards.values()]
			.map((card) => card.findIndex((row) => row.verdict === "PASS"))
			.filter((index) => index >= 0)
			.map((index) => index + 1);
		const outcomes = (verdict: string): number => list.filter((row) => !isQa(row) && row.verdict === verdict).length;
		return {
			who,
			cards: new Set(list.map((row) => row.devId)).size,
			firstPass: firsts.filter((row) => row.verdict === "PASS").length,
			firsts: firsts.length,
			toPass: mean(toPass),
			passed: toPass.length,
			fails: new Set(
				list.filter((row) => isQa(row) && row.verdict === "FAIL").map((row) => `${row.devId}|${row.round}`),
			).size,
			conflicts: outcomes("CONFLICT"),
			escalations: outcomes("ESCALATED"),
			agentErrors: outcomes("AGENT_ERROR"),
			means: scoreMeans(list.filter(isQa)),
		};
	});
	out.sort((a, b) => b.firstPass / (b.firsts || 1) - a.firstPass / (a.firsts || 1) || b.cards - a.cards);
	const lines = [
		`| agent · provider/model | cards | 1st-round PASS | avg rounds to PASS | FAIL rounds | conflicts | escalations | agent errors | ${SCORE_DIMENSIONS.join(" | ")} |`,
		`|---|---:|---|---:|---:|---:|---:|${SCORE_DIMENSIONS.map(() => "---:").join("|")}|`,
	];
	for (const entry of out) {
		lines.push(
			`| ${escapeCell(entry.who)} | ${entry.cards} | ${percent(entry.firstPass, entry.firsts)} | ${entry.passed ? `${formatNumber(entry.toPass)} (n=${entry.passed})` : "–"} | ${entry.fails} | ${entry.conflicts} | ${entry.escalations} | ${entry.agentErrors} | ${SCORE_DIMENSIONS.map((dimension) => formatNumber(entry.means[dimension])).join(" | ")} |`,
		);
	}
	return lines.join("\n");
}

function leaderboard(rows: ScoreboardLine[]): string {
	const out = [...groupBy(rows.filter(isQa), modelKey)].map(([model, list]) => {
		const cards = groupBy(list, (row) => row.devId);
		const latest = [...cards.values()]
			.map((card) => [...card].sort(byRound).at(-1))
			.filter((row): row is ScoreboardLine => Boolean(row));
		const judged = latest.filter((row) => row.verdict);
		const firsts = [...cards.values()]
			.map((card) => card.find((row) => row.round === 1))
			.filter((row): row is ScoreboardLine => Boolean(row?.verdict));
		const numbers = (pick: (row: ScoreboardLine) => number | null | undefined): number[] =>
			latest.map(pick).filter((value): value is number => typeof value === "number");
		const costs = latest.map((row) => row.metrics?.costUSD);
		const known = costs.filter((value): value is number => typeof value === "number");
		const calls = latest.reduce((sum, row) => sum + (row.metrics?.toolCalls || 0), 0);
		const errors = latest.reduce((sum, row) => sum + (row.metrics?.toolErrors || 0), 0);
		return {
			model,
			cards: cards.size,
			rounds: list.length,
			pass: judged.filter((row) => row.verdict === "PASS").length,
			judged: judged.length,
			firstPass: firsts.filter((row) => row.verdict === "PASS").length,
			firsts: firsts.length,
			means: scoreMeans(list),
			wall: mean(numbers((row) => row.metrics?.wallMin)),
			active: mean(numbers((row) => row.metrics?.activeMin)),
			cost: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
			costUnknown: costs.length - known.length,
			toolErrorRate: calls ? errors / calls : null,
			calls,
			errors,
		};
	});
	out.sort((a, b) => b.pass / (b.judged || 1) - a.pass / (a.judged || 1) || b.cards - a.cards);
	const lines = [
		`| model | cards | rounds | pass rate | 1st-round pass | ${SCORE_DIMENSIONS.join(" | ")} | mean wall (min) | mean active (min) | total cost ($) | tool-error rate |`,
		`|---|---:|---:|---|---|${SCORE_DIMENSIONS.map(() => "---:").join("|")}|---:|---:|---:|---|`,
	];
	for (const entry of out) {
		const cost =
			entry.cost === null
				? "n/a (no price)"
				: `${entry.cost.toFixed(2)}${entry.costUnknown ? ` +${entry.costUnknown} unpriced` : ""}`;
		const toolErrors =
			entry.toolErrorRate === null
				? "–"
				: `${(100 * entry.toolErrorRate).toFixed(0)}% (${entry.errors}/${entry.calls})`;
		lines.push(
			`| ${escapeCell(entry.model)} | ${entry.cards} | ${entry.rounds} | ${percent(entry.pass, entry.judged)} | ${percent(entry.firstPass, entry.firsts)} | ${SCORE_DIMENSIONS.map((dimension) => formatNumber(entry.means[dimension])).join(" | ")} | ${formatNumber(entry.wall)} | ${formatNumber(entry.active)} | ${cost} | ${toolErrors} |`,
		);
	}
	return lines.join("\n");
}

function cardTable(rows: ScoreboardLine[]): string {
	const lines = [
		"| ts (UTC) | card | round | verdict | model | src | scores s/c/t/u/cd/p | wall | active | cost | tool err/calls | visual | blocking | title / notes |",
		"|---|---|---:|---|---|---|---|---:|---:|---:|---|---|---:|---|",
	];
	for (const row of rows) {
		const scores = row.scores ? SCORE_DIMENSIONS.map((dimension) => row.scores?.[dimension] ?? "–").join("/") : "–";
		const visual = row.visual
			? `${row.visual.status}${row.visual.consoleErrors ? ` (${row.visual.consoleErrors} err)` : ""}`
			: "–";
		const titleNotes = [row.title?.slice(0, 50), row.notes?.slice(0, 120)].filter(Boolean).join(" — ");
		lines.push(
			`| ${(row.ts || "").slice(0, 16).replace("T", " ")} | ${row.devId} | ${row.round} | ${row.verdict ?? "ungraded"}${isQa(row) ? "" : ` (${row.source})`} | ${escapeCell(modelKey(row))} | ${row.modelSource ?? "–"} | ${scores} | ${formatNumber(row.metrics?.wallMin)} | ${formatNumber(row.metrics?.activeMin)} | ${formatNumber(row.metrics?.costUSD, 2)} | ${row.metrics ? `${row.metrics.toolErrors}/${row.metrics.toolCalls}` : "–"} | ${visual} | ${row.blocking?.length ?? 0} | ${escapeCell(titleNotes)} |`,
		);
	}
	return lines.join("\n");
}

export interface ScoreboardMarkdownInput {
	/** Shown in the title ("<name> QA scoreboard"). */
	name: string;
	/** The jsonl the rows came from (shown in the header). */
	sourcePath: string;
	file: ScoreboardFile;
	generatedAt: Date;
}

export function renderScoreboardMarkdown(input: ScoreboardMarkdownInput): string {
	const { rows, lines, bad } = input.file;
	const groups = new Map<string, ScoreboardLine[]>([["", rows.filter((row) => !row.benchmark)]]);
	for (const row of rows.filter((entry) => entry.benchmark)) {
		const name = row.benchmark ?? "";
		groups.set(name, [...(groups.get(name) ?? []), row]);
	}
	const md = [
		`# ${input.name} QA scoreboard`,
		"",
		`Generated ${input.generatedAt.toISOString()} from ${input.sourcePath} (${lines} lines, ${rows.length} after de-duplicating re-runs${bad.length ? `, unparseable lines: ${bad.join(",")}` : ""}).`,
		"Models come from the agents' session files (src=session) unless noted (src=board). Pass rate uses each card's latest verdict; wall (first session -> review snapshot), active (sum of session durations), cost and tool errors use each card's latest round (cumulative). Cost is list price with cache reads and writes priced separately; – = no published price.",
		"",
		"## Dev cards — team flow by agent/provider/model",
		"",
		"Each QA round is attributed to the agent/model that did that round (rework included). 1st-round PASS = the card's first PASS/FAIL QA verdict; avg rounds to PASS counts QA PASS/FAIL rounds up to the first PASS (cards that passed); conflicts = QA PASS that didn't merge into its base; escalations = handed to a human (FAIL rounds used up, STALLED/DNF, rework impossible); agent errors = the agent session itself died (API/tool-call errors), nudged without a QA round.",
		"",
		teamFlow(groups.get("") ?? []),
		"",
	];
	for (const [name, list] of groups) {
		if (list.length) {
			md.push(`## ${name ? `Benchmark: ${name}` : "Dev cards"} — leaderboard`, "", leaderboard(list), "");
		}
	}
	for (const [name, list] of groups) {
		if (list.length) {
			md.push(`## ${name ? `Benchmark: ${name}` : "Dev cards"} — per card`, "", cardTable(list), "");
		}
	}
	return md.join("\n");
}
