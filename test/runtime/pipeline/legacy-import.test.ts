import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LegacyKitService } from "../../../src/config/legacy-kit-config";
import { resolveLegacyKitProjectFiles } from "../../../src/config/legacy-kit-config";
import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { readRunoffs } from "../../../src/kits/team/runoffs/runoffs-store";
import {
	formatLegacyImportReport,
	type LegacyImportTargets,
	runLegacyImport,
} from "../../../src/pipeline/legacy-import";
import {
	getPipelineQaLogPath,
	getPipelineStatePath,
	getTeamBenchWorkspacePaths,
	getWatchdogWorkspacePaths,
} from "../../../src/state/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

// Trimmed copies of foo's legacy files (2026-10-07): three checks-state.json entries (a bare-string one, a card that
// is still open, one that is trashed), a decided and the open bench-only runoff group, three scoreboard lines.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "legacy-import");
const readFixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const OPEN_RUNOFF = "tier2-coupons-kimi-k3-bench-2026-10-07";
const DECIDED_RUNOFF = "tier2-coupons-v2-2026-10-06";

function services(autoland: Partial<LegacyKitService> = {}): LegacyKitService[] {
	return [
		{ name: "autoland", disabled: true, pid: null, ...autoland },
		{ name: "review-watch", disabled: true, pid: null },
	];
}

describe("kanban pipeline import-legacy", () => {
	const savedKitHome = process.env.KANBAN_KIT_HOME;
	let temp: ReturnType<typeof createTempDir>;
	let kitHome = "";
	let home = "";
	let targets: LegacyImportTargets;
	let config: unknown;
	let autoland: Partial<LegacyKitService>;
	const legacyRaw = {
		projects: [
			{
				workspaceId: "foo",
				scoreboard: "<dataDir>/bench/scoreboard.jsonl",
				toggles: { QA_CREATE: true, AUTO_REWORK: true, AUTO_DONE: true },
			},
		],
	};
	const board = createBoard({
		backlog: [createCard({ id: "66311" })],
		review: [createCard({ id: "144da" })],
		trash: [createCard({ id: "f80db" })],
	});

	beforeEach(() => {
		temp = createTempDir("kanban-legacy-import-");
		kitHome = join(temp.path, "kit");
		home = join(temp.path, "home");
		process.env.KANBAN_KIT_HOME = kitHome;
		const legacyData = join(kitHome, "data", "foo");
		mkdirSync(join(legacyData, "bench"), { recursive: true });
		for (const name of ["checks-state.json", "runoffs.json", "qa-log.md"]) {
			copyFileSync(join(FIXTURES, name), join(legacyData, name));
		}
		copyFileSync(join(FIXTURES, "scoreboard.jsonl"), join(legacyData, "bench", "scoreboard.jsonl"));
		const bench = getTeamBenchWorkspacePaths("foo", home);
		targets = {
			pipelineState: getPipelineStatePath("foo", home),
			runoffs: getWatchdogWorkspacePaths("foo", home).runoffs,
			scoreboardJsonl: bench.scoreboardJsonl,
			scoreboardMd: bench.scoreboardMd,
			qaLog: getPipelineQaLogPath("foo", home),
		};
		config = { workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" }, pipeline: { shadow: true } } } };
		autoland = {};
	});
	afterEach(() => {
		if (savedKitHome === undefined) {
			delete process.env.KANBAN_KIT_HOME;
		} else {
			process.env.KANBAN_KIT_HOME = savedKitHome;
		}
		temp.cleanup();
	});

	const run = async (options: { dryRun?: boolean; force?: boolean } = {}) =>
		await runLegacyImport(
			{
				workspaceId: "foo",
				repoPath: "/projects/foo",
				dryRun: options.dryRun ?? false,
				force: options.force ?? false,
			},
			{
				readConfig: async () => parsePipelineConfig(config),
				readLegacyKit: async () => ({ path: join(kitHome, "kit.config.json"), raw: legacyRaw, error: null }),
				readServices: () => services(autoland),
				targets: () => targets,
				loadBoard: async () => board,
				now: () => new Date("2026-10-07T12:00:00.000Z"),
			},
		);

	const legacySnapshot = () =>
		["checks-state.json", "runoffs.json", "qa-log.md", join("bench", "scoreboard.jsonl")].map((name) =>
			readFileSync(join(kitHome, "data", "foo", name), "utf8"),
		);

	/** A pipeline-state.json from the shadow day's first import: 144da before its round-2 PASS, plus a Kanban key. */
	function writeShadowDayState(): void {
		const legacy = JSON.parse(readFixture("checks-state.json")) as Record<string, Record<string, unknown>>;
		const older = structuredClone(legacy["144da"]) as { qaflow: Record<string, unknown> } & Record<string, unknown>;
		older.qaflow = { handled: ["r1|FAIL|2026-10-05T04:01:40.142Z"], lastRound: 1, kanbanOnly: true };
		mkdirSync(dirname(targets.pipelineState), { recursive: true });
		writeFileSync(
			targets.pipelineState,
			JSON.stringify({
				version: 1,
				since: "2026-10-05T03:01:03.576Z",
				importedFrom: "checks-state.json",
				cards: {
					"66311": { snapshot: legacy["66311"] },
					"144da": { ...older, qaGate: { qaTaskId: "qa001" } },
					f80db: { snapshot: "old" },
				},
			}),
		);
	}

	it("finds the legacy kit's files the way its lib/config.cjs does", () => {
		expect(resolveLegacyKitProjectFiles(legacyRaw, "foo")).toEqual({
			dataDir: join(kitHome, "data", "foo"),
			state: join(kitHome, "data", "foo", "checks-state.json"),
			scoreboard: join(kitHome, "data", "foo", "bench", "scoreboard.jsonl"),
			runoffs: join(kitHome, "data", "foo", "runoffs.json"),
			qaLog: join(kitHome, "data", "foo", "qa-log.md"),
		});
		const moved = resolveLegacyKitProjectFiles(
			{ dataRoot: "<kitHome>/elsewhere", projects: [{ workspaceId: "bar", runoffs: "/abs/runoffs.json" }] },
			"bar",
		);
		expect(moved.dataDir).toBe(join(kitHome, "elsewhere", "bar"));
		expect(moved.runoffs).toBe("/abs/runoffs.json");
		expect(moved.scoreboard).toBe(join(kitHome, "elsewhere", "bar", "scoreboard.jsonl"));
	});

	it("copies open cards' entries, runoffs, the scoreboard and the QA log, and a second run changes nothing", async () => {
		writeShadowDayState();
		const legacyLines = readFixture("scoreboard.jsonl").trim().split("\n");
		const ownLine = JSON.stringify({
			...JSON.parse(legacyLines[0] ?? "{}"),
			source: "pipeline",
			verdict: "ESCALATED",
		});
		mkdirSync(dirname(targets.scoreboardJsonl), { recursive: true });
		writeFileSync(targets.scoreboardJsonl, `${legacyLines[1]}\n${ownLine}\n`);
		const decided = (await readRunoffs(join(FIXTURES, "runoffs.json"))).runoffs.find(
			(entry) => entry.name === DECIDED_RUNOFF,
		);
		writeFileSync(targets.runoffs, JSON.stringify({ runoffs: [{ ...decided, winner: null }] }));
		const before = legacySnapshot();

		const report = await run();

		expect(report.refusals).toEqual([]);
		expect(report.skipped).toEqual([]);
		expect(report.pipelineState).toMatchObject({
			created: false,
			changes: [{ taskId: "144da", action: "updated" }],
			unchanged: ["66311"],
			skipped: ["f80db"],
		});
		expect(report.pipelineState?.changes[0]?.keys).toEqual(
			expect.arrayContaining(["qaflow.handled", "qaflow.lastRound", "qaflow.failRounds"]),
		);
		const state = JSON.parse(readFileSync(targets.pipelineState, "utf8")) as {
			cards: Record<string, Record<string, unknown>>;
		};
		const legacyState = JSON.parse(readFixture("checks-state.json")) as Record<string, Record<string, unknown>>;
		// The legacy kit's keys win; what only Kanban wrote stays.
		expect(state.cards["144da"]).toMatchObject({
			...legacyState["144da"],
			qaGate: { qaTaskId: "qa001" },
			qaflow: { ...(legacyState["144da"]?.qaflow as object), kanbanOnly: true },
		});
		// A trashed card's entry is left as it was.
		expect(state.cards.f80db).toEqual({ snapshot: "old" });

		expect(report.runoffs).toMatchObject({ added: [OPEN_RUNOFF], replaced: [DECIDED_RUNOFF], open: [OPEN_RUNOFF] });
		const runoffs = (await readRunoffs(targets.runoffs)).runoffs;
		expect(runoffs.map((entry) => entry.name)).toEqual([DECIDED_RUNOFF, OPEN_RUNOFF]);
		expect(runoffs[0]?.winner).toBe("f496b");
		// Fields the schema doesn't name (the `reopened` note) are copied too.
		expect(runoffs[0]?.reopened).toEqual(decided?.reopened);

		expect(report.scoreboard).toMatchObject({ alreadyThere: 1, badLegacyLines: [] });
		expect(report.scoreboard?.added).toHaveLength(2);
		// Legacy lines first (older), then Kanban's file as it was.
		expect(readFileSync(targets.scoreboardJsonl, "utf8")).toBe(
			`${legacyLines[0]}\n${legacyLines[2]}\n${legacyLines[1]}\n${ownLine}\n`,
		);
		expect(readFileSync(targets.scoreboardMd, "utf8")).toContain("Generated 2026-10-07T12:00:00.000Z");

		expect(report.qaLog).toBe("copied");
		expect(readFileSync(targets.qaLog, "utf8")).toBe(readFixture("qa-log.md"));

		const lines = formatLegacyImportReport(report);
		expect(lines).toContain(`  copied ${OPEN_RUNOFF} (new, open)`);
		expect(lines.some((line) => line.includes("copied 2 line(s), 1 already there"))).toBe(true);

		const written = [targets.pipelineState, targets.runoffs, targets.scoreboardJsonl, targets.qaLog].map((path) =>
			readFileSync(path, "utf8"),
		);
		const again = await run();
		expect(again.pipelineState).toMatchObject({ changes: [], unchanged: ["66311", "144da"] });
		expect(again.runoffs).toMatchObject({ added: [], replaced: [], unchanged: [DECIDED_RUNOFF, OPEN_RUNOFF] });
		expect(again.scoreboard).toMatchObject({ added: [], alreadyThere: 3 });
		expect(again.qaLog).toBe("already-there");
		expect(
			[targets.pipelineState, targets.runoffs, targets.scoreboardJsonl, targets.qaLog].map((path) =>
				readFileSync(path, "utf8"),
			),
		).toEqual(written);
		// The legacy files are only read.
		expect(legacySnapshot()).toEqual(before);
	});

	it("creates pipeline-state.json from the whole checks-state.json when there is none", async () => {
		const report = await run();
		expect(report.pipelineState).toMatchObject({ created: true, changes: [], skipped: ["f80db"] });
		const state = JSON.parse(readFileSync(targets.pipelineState, "utf8")) as {
			since: string;
			cards: Record<string, unknown>;
		};
		expect(state.since).toBe("2026-10-05T03:01:03.576Z");
		expect(Object.keys(state.cards).sort()).toEqual(["144da", "66311", "f80db"]);
	});

	it("writes nothing on a dry run", async () => {
		writeShadowDayState();
		const stateBefore = readFileSync(targets.pipelineState, "utf8");
		const report = await run({ dryRun: true });
		expect(report.pipelineState?.changes.map((change) => change.taskId)).toEqual(["144da"]);
		expect(report.runoffs?.added).toEqual([DECIDED_RUNOFF, OPEN_RUNOFF]);
		expect(report.scoreboard?.added).toHaveLength(3);
		expect(report.qaLog).toBe("copied");
		expect(readFileSync(targets.pipelineState, "utf8")).toBe(stateBefore);
		for (const path of [targets.runoffs, targets.scoreboardJsonl, targets.scoreboardMd, targets.qaLog]) {
			expect(existsSync(path)).toBe(false);
		}
		expect(formatLegacyImportReport(report)[0]).toBe("Dry run: import of the legacy kit's state for foo");
	});

	it("leaves a QA log Kanban already wrote alone", async () => {
		mkdirSync(dirname(targets.qaLog), { recursive: true });
		writeFileSync(targets.qaLog, "# Kanban's own log\n");
		const report = await run();
		expect(report.qaLog).toBe("kept-different");
		expect(readFileSync(targets.qaLog, "utf8")).toBe("# Kanban's own log\n");
	});

	it("refuses while the workspace is not on landing qa in shadow", async () => {
		config = { workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" }, pipeline: { shadow: false } } } };
		const report = await run();
		expect(report.refusals).toEqual([expect.stringContaining("not landing qa in shadow")]);
		expect(report.pipelineState).toBeNull();
		expect(existsSync(join(home, "data"))).toBe(false);

		config = {};
		expect((await run()).refusals).toEqual([expect.stringContaining("foo is on landing off")]);
	});

	it("refuses while the legacy autoland owns the workspace; --force only plans, on a dry run", async () => {
		autoland = { pid: 4242, disabled: false };
		const report = await run();
		expect(report.refusals).toEqual([expect.stringContaining("autoland still owns foo (running, pid 4242)")]);
		expect(existsSync(join(home, "data"))).toBe(false);

		// Stopped but not disabled: review-watch or the bashrc hook starts it again.
		autoland = { pid: null, disabled: false };
		expect((await run()).refusals).toEqual([expect.stringContaining("not disabled")]);

		await expect(run({ force: true })).rejects.toThrow("--force only works with --dry-run");
		const forced = await run({ dryRun: true, force: true });
		expect(forced.refusals).toHaveLength(1);
		expect(forced.runoffs?.added).toEqual([DECIDED_RUNOFF, OPEN_RUNOFF]);
		expect(existsSync(join(home, "data"))).toBe(false);
	});

	it("does not refuse for a running autoland that doesn't list the workspace", async () => {
		autoland = { pid: 4242, disabled: false };
		const report = await runLegacyImport(
			{ workspaceId: "foo", repoPath: null, dryRun: true, force: false },
			{
				readConfig: async () => parsePipelineConfig(config),
				readLegacyKit: async () => ({ path: "kit.config.json", raw: { projects: [] }, error: null }),
				readServices: () => services(autoland),
				targets: () => targets,
				loadBoard: async () => board,
			},
		);
		expect(report.refusals).toEqual([]);
	});

	it("fails without a legacy kit config", async () => {
		await expect(
			runLegacyImport(
				{ workspaceId: "foo", repoPath: null, dryRun: true, force: false },
				{
					readConfig: async () => parsePipelineConfig(config),
					readLegacyKit: async () => ({ path: "/nowhere/kit.config.json", raw: null, error: null }),
					loadBoard: async () => board,
				},
			),
		).rejects.toThrow("no legacy kit config to import from (/nowhere/kit.config.json absent)");
	});
});
