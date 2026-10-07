import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../../../src/config/pipeline-config";
import { getBuiltInKits, getDefaultKit } from "../../../../../src/kits/resolve-kit";
import type { CardMetrics } from "../../../../../src/kits/team/bench/card-metrics";
import { createScoreboardFeature } from "../../../../../src/kits/team/scoreboard/scoreboard-feature";
import {
	buildScoreboardLine,
	normalizeScores,
	parseScoreboard,
	type ScoreboardLine,
} from "../../../../../src/kits/team/scoreboard/scoreboard-line";
import { renderScoreboardMarkdown } from "../../../../../src/kits/team/scoreboard/scoreboard-markdown";
import { getUnscoredCardRole } from "../../../../../src/kits/team/scoreboard/scoreboard-store";
import { createPipelineEventBus, type PipelineEventMap } from "../../../../../src/pipeline/events";
import { createPipelineFeatureRegistry } from "../../../../../src/pipeline/features";
import { getTeamBenchWorkspacePaths } from "../../../../../src/state/kanban-home";
import { createTempDir } from "../../../../utilities/temp-dir";

function metricsFor(devId: string, model = "us.moonshotai.kimi-k3"): CardMetrics {
	return {
		devId,
		title: `Card ${devId}`,
		agent: "cline",
		column: "review",
		provider: "bedrock",
		model,
		modelSource: "session",
		attribution: "all",
		roundSince: null,
		models: {},
		roundModels: {},
		boardModel: null,
		metrics: {
			wallMin: 30,
			activeMin: 20,
			sessions: 1,
			assistantTurns: 10,
			toolCalls: 20,
			toolErrors: 2,
			tokensIn: 1000,
			tokensOut: 100,
			tokensCacheRead: 0,
			tokensCacheWrite: 0,
			costUSD: 1.5,
			costUSDNoCache: 2,
		},
		wall: { start: null, end: null, endSource: null },
		sessionStatuses: {},
	};
}

function line(devId: string, round: number, verdict: ScoreboardLine["verdict"], extra: Partial<ScoreboardLine> = {}) {
	return {
		...buildScoreboardLine(metricsFor(devId), {
			at: new Date(Date.UTC(2026, 9, 7, 0, round)),
			round,
			verdict,
			source: extra.source === "qa" || extra.source === undefined ? "qa" : "pipeline",
		}),
		...extra,
	};
}

function teamKit() {
	const kit = getBuiltInKits().get("team");
	if (!kit) {
		throw new Error("team kit missing");
	}
	return kit;
}

describe("scoreboard lines", () => {
	it("validates verdicts per source and scores per dimension", () => {
		expect(() =>
			buildScoreboardLine(metricsFor("a"), { at: new Date(), round: 1, verdict: "ESCALATED", source: "qa" }),
		).toThrow(/PASS\|FAIL\|STALLED\|DNF/u);
		expect(() =>
			buildScoreboardLine(metricsFor("a"), { at: new Date(), round: 1, verdict: "PASS", source: "pipeline" }),
		).toThrow(/CONFLICT/u);
		expect(() =>
			buildScoreboardLine(metricsFor("a"), { at: new Date(), round: 0, verdict: "PASS", source: "qa" }),
		).toThrow(/positive integer/u);
		expect(normalizeScores({ spec: 4, ux: null, extra: 9 })).toEqual({
			spec: 4,
			correctness: null,
			tests: null,
			ux: null,
			code: null,
			process: null,
		});
		expect(() => normalizeScores({ spec: 6 })).toThrow(/integer 0-5/u);
		const built = buildScoreboardLine(metricsFor("a"), {
			at: new Date("2026-10-07T00:00:00Z"),
			round: 2,
			verdict: null,
			source: "qa",
			blocking: ["x".repeat(300)],
			notes: "n".repeat(500),
		});
		expect(built).toMatchObject({ verdict: null, round: 2, agent: "cline", model: "us.moonshotai.kimi-k3" });
		expect(built.blocking[0]).toHaveLength(200);
		expect(built.notes).toHaveLength(400);
	});

	it("keeps the last of re-run QA lines and reads the legacy kit's autoland outcome lines", () => {
		const legacyOutcome = { ...line("b", 1, "CONFLICT", { source: "autoland" }) };
		const text = [
			JSON.stringify(line("a", 1, "FAIL")),
			"not json",
			JSON.stringify(line("a", 1, "PASS", { ts: "2026-10-07T00:05:00.000Z" })),
			JSON.stringify(legacyOutcome),
			JSON.stringify(line("b", 1, "PASS")),
		].join("\n");
		const file = parseScoreboard(text);
		expect(file.lines).toBe(5);
		expect(file.bad).toEqual([2]);
		expect(file.rows.map((row) => `${row.devId} ${row.verdict} ${row.source}`)).toEqual([
			"b CONFLICT autoland",
			"b PASS qa",
			"a PASS qa",
		]);
	});
});

describe("scoreboard.md", () => {
	it("counts first-round passes and rounds to pass per model, and keeps outcomes out of the leaderboard", () => {
		const rows = [
			line("a", 1, "FAIL"),
			line("a", 2, "PASS"),
			line("b", 1, "PASS"),
			line("b", 2, "CONFLICT", { source: "pipeline" }),
			line("c", 1, "PASS", { benchmark: "tier3-coupons" }),
		];
		const md = renderScoreboardMarkdown({
			name: "foo",
			sourcePath: "/data/foo/scoreboard.jsonl",
			file: { lines: rows.length, bad: [], rows },
			generatedAt: new Date("2026-10-07T00:00:00Z"),
		});
		expect(md).toContain("# foo QA scoreboard");
		expect(md).toContain("(5 lines, 5 after de-duplicating re-runs)");
		// Team flow (regular dev cards a and b): first-round PASS 1 of 2; avg rounds to PASS (2 + 1) / 2; one conflict.
		expect(md).toContain("| cline · bedrock/us.moonshotai.kimi-k3 | 2 | 50% (1/2) | 1.5 (n=2) | 1 | 1 | 0 | 0 |");
		// The regular leaderboard: a and b (c is a benchmark card), the CONFLICT line isn't a round.
		expect(md).toContain("| bedrock/us.moonshotai.kimi-k3 | 2 | 3 | 100% (2/2) | 50% (1/2) |");
		expect(md).toContain("## Benchmark: tier3-coupons — leaderboard");
		expect(md).toContain("| CONFLICT (pipeline) |");
	});
});

describe("scoreboard feature", () => {
	let dir: { path: string; cleanup: () => void };
	beforeEach(() => {
		dir = createTempDir("scoreboard-feature-");
	});
	afterEach(() => {
		dir.cleanup();
	});

	function setup() {
		const bus = createPipelineEventBus();
		const log = vi.fn();
		const registry = createPipelineFeatureRegistry({ bus, log });
		const measure = vi.fn(async (input: { taskId: string; workspaceId: string | null }) => ({
			metrics: metricsFor(input.taskId),
			workspaceId: input.workspaceId,
			repoPath: "/projects/foo",
		}));
		registry.register(
			createScoreboardFeature({
				readConfig: async () => parsePipelineConfig({}),
				measure,
				paths: (workspaceId) => getTeamBenchWorkspacePaths(workspaceId, dir.path),
			}),
		);
		return { bus, registry, measure, log };
	}

	const verdict = (workspaceId: string, round = 1): PipelineEventMap["verdictRecorded"] => ({
		workspaceId,
		taskId: "dev01",
		at: Date.parse("2026-10-07T01:00:00Z"),
		qaTaskId: "qa001",
		verdict: { verdict: round === 1 ? "FAIL" : "PASS", round, blocking: ["login 500s"], notes: "see qa-log" },
		devAgentId: "cline",
		devModel: { provider: "bedrock", model: "us.moonshotai.kimi-k3" },
		qaAgentId: "codex",
		qaModel: null,
		report: {
			scores: { spec: 4, correctness: 3, tests: 3, ux: null, code: 4, process: 3 },
			visual: { status: "ok", artifacts: ["r1/shot.png"], consoleErrors: 0 },
		},
	});

	it("writes one line per verdictRecorded and rebuilds scoreboard.md, only on workspaces whose kit lists it", async () => {
		const { bus, registry, measure } = setup();
		registry.syncWorkspace("foo", teamKit());
		registry.syncWorkspace("kanban-2uge", getDefaultKit());

		await bus.emit("verdictRecorded", verdict("foo"));
		await bus.emit("verdictRecorded", verdict("kanban-2uge"));

		const foo = getTeamBenchWorkspacePaths("foo", dir.path);
		const rows = parseScoreboard(readFileSync(foo.scoreboardJsonl, "utf8")).rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			devId: "dev01",
			round: 1,
			verdict: "FAIL",
			source: "qa",
			ts: "2026-10-07T01:00:00.000Z",
			blocking: ["login 500s"],
			scores: { spec: 4, ux: null },
			visual: { status: "ok", artifacts: ["r1/shot.png"] },
			metrics: { costUSD: 1.5 },
		});
		expect(readFileSync(foo.scoreboardMd, "utf8")).toContain("# foo QA scoreboard");
		expect(measure).toHaveBeenCalledTimes(1);
		expect(measure).toHaveBeenCalledWith(expect.objectContaining({ taskId: "dev01", workspaceId: "foo" }));
		// The default kit's workspace has no scoreboard at all.
		expect(() => readFileSync(getTeamBenchWorkspacePaths("kanban-2uge", dir.path).scoreboardJsonl)).toThrow();
	});

	it("records ESCALATED and HUMAN_APPROVED outcomes, never a QA landing", async () => {
		const { bus, registry } = setup();
		registry.syncWorkspace("foo", teamKit());
		await bus.emit("verdictRecorded", verdict("foo", 1));
		await bus.emit("verdictRecorded", verdict("foo", 2));
		await bus.emit("landed", {
			workspaceId: "foo",
			taskId: "dev01",
			at: 2,
			baseRef: "main",
			commit: "abc",
			via: "qa",
		});
		await bus.emit("escalated", {
			workspaceId: "foo",
			taskId: "dev02",
			at: 3,
			to: "orchestrator",
			requireApproval: true,
			reason: "3 FAIL rounds",
			round: 3,
		});
		await bus.emit("landed", {
			workspaceId: "foo",
			taskId: "dev01",
			at: 4,
			baseRef: "main",
			commit: "def",
			via: "approved",
		});

		const rows = parseScoreboard(
			readFileSync(getTeamBenchWorkspacePaths("foo", dir.path).scoreboardJsonl, "utf8"),
		).rows;
		expect(rows.map((row) => `${row.devId} r${row.round} ${row.verdict} ${row.source}`)).toEqual([
			"dev02 r3 ESCALATED pipeline",
			"dev01 r3 HUMAN_APPROVED pipeline",
			"dev01 r1 FAIL qa",
			"dev01 r2 PASS qa",
		]);
	});

	it("keeps a line when QA's scores are malformed, and logs why", async () => {
		const { bus, registry, log } = setup();
		registry.syncWorkspace("foo", teamKit());
		await bus.emit("verdictRecorded", { ...verdict("foo"), report: { scores: { spec: 9 }, visual: "nonsense" } });
		const rows = parseScoreboard(
			readFileSync(getTeamBenchWorkspacePaths("foo", dir.path).scoreboardJsonl, "utf8"),
		).rows;
		expect(rows[0]).toMatchObject({ scores: null, visual: { status: "n/a" } });
		expect(log).toHaveBeenCalledWith(expect.stringContaining("scores ignored"));
	});

	it("an existing legacy scoreboard keeps its lines when the feature appends", async () => {
		const { bus, registry } = setup();
		registry.syncWorkspace("foo", teamKit());
		const foo = getTeamBenchWorkspacePaths("foo", dir.path);
		mkdirSync(foo.dataDir, { recursive: true });
		writeFileSync(foo.scoreboardJsonl, `${JSON.stringify(line("old01", 1, "ESCALATED", { source: "autoland" }))}\n`);
		await bus.emit("verdictRecorded", verdict("foo"));
		expect(parseScoreboard(readFileSync(foo.scoreboardJsonl, "utf8")).rows.map((row) => row.devId)).toEqual([
			"old01",
			"dev01",
		]);
		expect(join(foo.dataDir, "scoreboard.jsonl")).toBe(foo.scoreboardJsonl);
	});
});

describe("which cards are scored", () => {
	it("refuses QA and TRIAGE cards, including the legacy kit's role-less ones; calibration and dev cards are scored", () => {
		expect(getUnscoredCardRole({ role: "qa", prompt: "" })).toBe("qa");
		expect(getUnscoredCardRole({ title: "QA2 abc12: Fix login", prompt: "anything" })).toBe("qa");
		expect(getUnscoredCardRole({ title: "TRIAGE abc12: stuck", prompt: "" })).toBe("triage");
		expect(getUnscoredCardRole({ title: "QA-CAL v5 B", prompt: "" })).toBeNull();
		expect(getUnscoredCardRole({ title: "QA gate: wire the outbox", prompt: "Implement…" })).toBeNull();
		expect(getUnscoredCardRole({ role: "dev", title: "QA1 abc12: x", prompt: "" })).toBeNull();
	});
});
