// QA waits for the scripted checks (user's choice "D", 2026-10-07): the QA gate creates a dev card's QA card only once
// the checks of its current snapshot are recorded, or after `pipeline.qa.checksWaitMin`, and the QA prompt gets their
// report. These run the pipeline worker with the real QA gate; the checks runner is faked so each test decides when
// (and with which result) the checks finish.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import type { CheckStepResult, ChecksResult, ChecksRunner } from "../../../src/pipeline/checks";
import { buildQaChecksReport } from "../../../src/pipeline/qa-checks-report";
import { readQaGateEntry } from "../../../src/pipeline/qa-gate";
import { createPipelineWorkerHarness, createSnapshot, type QaGateHarnessAction } from "../../utilities/pipeline-worker";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const T0 = Date.parse("2026-10-07T10:00:00.000Z");
const QA_WORKSPACE = { landing: { mode: "qa" }, kit: { name: "team" } };
const DEV = createCard({ id: "d1111" });

function createdTasks(actions: QaGateHarnessAction[]) {
	return actions.flatMap((action) => (action.kind === "createTask" ? [action.task] : []));
}

function checksResult(
	snapshot: string,
	verdict: ChecksResult["verdict"],
	steps: CheckStepResult[],
	error: string | null = null,
): ChecksResult {
	return {
		request: {
			workspaceId: "foo",
			repoPath: "/repos/foo",
			taskId: DEV.id,
			title: DEV.title,
			baseRef: "main",
			snapshot,
			scripts: ["lint", "test"],
		},
		verdict,
		harness: verdict === "ERROR",
		steps,
		logsDir: `/tmp/kanban-checks/foo/${DEV.id}/.checks`,
		startedAt: Date.now() - 60_000,
		finishedAt: Date.now(),
		timeoutMin: 15,
		error,
	};
}

const INSTALL: CheckStepResult = { name: "install", command: "npm ci --no-audit --no-fund", ok: true, ms: 20_000 };
const LINT: CheckStepResult = { name: "lint", command: "npm run -s lint", ok: true, ms: 4_000, text: "ok" };

describe("QA gate: QA waits for the scripted checks", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
		vi.useRealTimers();
	});

	function setup(options: { config?: unknown; checkScripts?: string[]; snapshot?: () => string } = {}) {
		let onChecksResult: ((result: ChecksResult) => Promise<void>) | null = null;
		const runner: ChecksRunner = { enqueue: () => "queued", idle: async () => {}, close: () => {} };
		const harness = createPipelineWorkerHarness({
			config: options.config ?? { workspaces: { foo: QA_WORKSPACE } },
			clock: () => Date.now(),
			checkScripts: () => options.checkScripts ?? ["lint", "test"],
			createChecks: (onResult) => {
				onChecksResult = onResult;
				return runner;
			},
		});
		harnesses.push(harness);
		const send = async (
			columns: { review?: RuntimeBoardCard[]; backlog?: RuntimeBoardCard[] } = { review: [DEV] },
		) => {
			await harness.send(
				createSnapshot({ workspaceId: "foo", board: createBoard(columns), selectedAgentId: "claude" }),
			);
		};
		/** The checks finish: the worker records the result and evaluates the workspace again by itself. */
		const finishChecks = async (result: ChecksResult) => {
			await onChecksResult?.(result);
			await harness.worker.idle();
		};
		return { harness, send, finishChecks };
	}

	it("creates no QA card while the checks run, then one with their PASS report once they finish", async () => {
		const { harness, send, finishChecks } = setup();
		await send();
		expect(createdTasks(harness.actions)).toEqual([]);
		expect(harness.readCardDecisions("foo")).toMatchObject([
			{
				taskId: DEV.id,
				outcome: "none",
				note: expect.stringContaining(
					"QA waits for checks on snap-d11 (up to 20 min, until 2026-10-07T10:20:00.000Z)",
				),
			},
		]);
		expect((await harness.store.load("foo")).cards[DEV.id]?.qaChecksWait).toEqual({
			snapshot: `snap-${DEV.id}`,
			since: T0,
		});

		// Waiting is logged once, however often the card is evaluated.
		vi.advanceTimersByTime(60_000);
		await send();
		expect(harness.readCardDecisions("foo")).toHaveLength(1);

		await finishChecks(
			checksResult(`snap-${DEV.id}`, "PASS", [
				INSTALL,
				LINT,
				{ name: "test", command: "npm run -s test", ok: true, ms: 95_000, text: "Tests  3 passed" },
			]),
		);
		const [task] = createdTasks(harness.actions);
		expect(task?.taskId).toBe("qa001");
		expect(task?.prompt).toContain(
			[
				'"""',
				"",
				"SCRIPTED CHECKS of snapshot snap-d11, run by the pipeline before this QA card started:",
				"- Result: PASS (logs: /tmp/kanban-checks/foo/d1111/.checks)",
				"- install: ok in 20s (npm ci --no-audit --no-fund)",
				"- lint: ok in 4s (npm run -s lint)",
				"- test: ok in 95s (npm run -s test)",
				"You may rely on these results in step 2 instead of running the same scripts again.",
			].join("\n"),
		);
		expect(task?.prompt.endsWith("instead of running the same scripts again.")).toBe(true);
		const state = await harness.store.load("foo");
		expect(readQaGateEntry(state.cards.qa001)).toMatchObject({ status: "queued", checks: "PASS" });
		expect(state.cards[DEV.id]).not.toHaveProperty("qaChecksWait");
		expect(harness.readCardDecisions("foo").at(-1)).toMatchObject({
			outcome: "acted",
			note: expect.stringContaining("QA card qa001 was created for snapshot snap-d11 (round 1, ") as string,
		});
		expect(harness.readCardDecisions("foo").at(-1)?.note).toMatch(/with checks PASS$/u);
		// The shadow diff's fields are unchanged.
		expect(harness.readCardDecisions("foo").at(-1)?.answer).toMatchObject({ kind: "qa" });
	});

	it("puts a failing step's command, duration and output tail in the report", async () => {
		const { harness, send, finishChecks } = setup();
		await send();
		const output = Array.from({ length: 80 }, (_, index) => `out ${index}`).join("\n");
		await finishChecks(
			checksResult(`snap-${DEV.id}`, "FAIL", [
				INSTALL,
				LINT,
				{ name: "test", command: "npm run -s test", ok: false, ms: 61_000, text: output },
			]),
		);
		const prompt = createdTasks(harness.actions)[0]?.prompt ?? "";
		expect(prompt).toContain("- Result: FAIL (logs: /tmp/kanban-checks/foo/d1111/.checks)");
		expect(prompt).toContain(
			"- test: FAILED in 61s (npm run -s test); the last 60 line(s) of its output:\n    out 20\n",
		);
		expect(prompt).toContain("    out 79\nA failed step is not blocking by itself");
		expect(prompt).not.toContain("    out 19\n");
		expect(prompt).toContain("compare against main (step 2)");
		expect(readQaGateEntry((await harness.store.load("foo")).cards.qa001)?.checks).toBe("FAIL");
	});

	it("reports a checker ERROR as checks that did not run", async () => {
		const { harness, send, finishChecks } = setup();
		await send();
		await finishChecks(checksResult(`snap-${DEV.id}`, "ERROR", [], "exporting snap-d11 failed: tar exited with 2"));
		const prompt = createdTasks(harness.actions)[0]?.prompt ?? "";
		expect(prompt).toContain(
			"- Result: ERROR: the checker itself failed (exporting snap-d11 failed: tar exited with 2), so the checks did NOT run. Run the typecheck/lint/test/build scripts yourself in step 2.",
		);
		expect(harness.readCardDecisions("foo").at(-1)?.note).toMatch(/with checks ERROR$/u);
	});

	it("starts QA with 'checks timed out' after checksWaitMin, on its own wake", async () => {
		const { harness, send, finishChecks } = setup({
			config: { workspaces: { foo: QA_WORKSPACE }, pipeline: { qa: { checksWaitMin: 10 } } },
		});
		await send();
		vi.advanceTimersByTime(10 * 60_000 - 1);
		await harness.worker.idle();
		expect(createdTasks(harness.actions)).toEqual([]);

		// No new snapshot: the worker's own wake re-evaluates the workspace at the deadline.
		vi.advanceTimersByTime(1);
		await harness.worker.idle();
		const prompt = createdTasks(harness.actions)[0]?.prompt ?? "";
		expect(prompt).toContain(
			"- Result: TIMED OUT: the checks were still queued or running after 10 min, so they did NOT run in time and QA started without them.",
		);
		expect(readQaGateEntry((await harness.store.load("foo")).cards.qa001)?.checks).toBe("timed_out");
		expect(harness.readCardDecisions("foo").at(-1)?.note).toMatch(/with checks timed out$/u);

		// The late result is recorded for people to read; it makes no second QA card.
		await finishChecks(checksResult(`snap-${DEV.id}`, "PASS", [INSTALL]));
		expect(createdTasks(harness.actions)).toHaveLength(1);
	});

	it("a snapshot that changes while the checks run supersedes them: no QA for the stale one", async () => {
		let snapshot = "aaaa1111aaaa1111";
		const { harness, send, finishChecks } = setup();
		harness.setSnapshot(() => snapshot);
		await send();
		vi.advanceTimersByTime(5 * 60_000);
		snapshot = "bbbb2222bbbb2222";
		await send();
		expect((await harness.store.load("foo")).cards[DEV.id]?.qaChecksWait).toEqual({
			snapshot,
			since: T0 + 5 * 60_000,
		});

		// The old snapshot's result (a run that finished just before it was stopped) starts nothing.
		await finishChecks(checksResult("aaaa1111aaaa1111", "PASS", [INSTALL]));
		expect(createdTasks(harness.actions)).toEqual([]);
		expect(harness.readCardDecisions("foo").at(-1)?.note).toContain("QA waits for checks on bbbb2222");

		await finishChecks(checksResult(snapshot, "PASS", [INSTALL]));
		expect(createdTasks(harness.actions)).toHaveLength(1);
		expect(readQaGateEntry((await harness.store.load("foo")).cards.qa001)?.snapshot).toBe(snapshot);
	});

	it("doesn't wait when the snapshot has no check scripts or the workspace runs no checks", async () => {
		const noScripts = setup({ checkScripts: [] });
		await noScripts.send();
		const [task] = createdTasks(noScripts.harness.actions);
		expect(task?.taskId).toBe("qa001");
		expect(task?.prompt).not.toContain("SCRIPTED CHECKS");
		expect(readQaGateEntry((await noScripts.harness.store.load("foo")).cards.qa001)?.checks).toBeNull();

		const checksOff = setup({
			config: { workspaces: { foo: { ...QA_WORKSPACE, checks: { enabled: false } } } },
		});
		await checksOff.send();
		expect(createdTasks(checksOff.harness.actions)).toHaveLength(1);
	});

	it("starts QA right away on checks already recorded for the snapshot", async () => {
		const { harness, send, finishChecks } = setup();
		await finishChecks(checksResult(`snap-${DEV.id}`, "PASS", [INSTALL]));
		await send();
		expect(createdTasks(harness.actions)[0]?.prompt).toContain("- Result: PASS");
	});

	it("still holds QA back for a turn recovery resent, also when the checks finish meanwhile", async () => {
		const { harness, send, finishChecks } = setup();
		await harness.store.update("foo", (state) => ({
			...state,
			cards: { ...state.cards, [DEV.id]: { qaflow: { recoverySentAt: new Date(T0).toISOString() } } },
		}));
		await send();
		await finishChecks(checksResult(`snap-${DEV.id}`, "PASS", [INSTALL]));
		expect(createdTasks(harness.actions)).toEqual([]);
		expect(harness.readCardDecisions("foo")).toEqual([]);

		// The redone turn ended after the resend: its settled Review gets QA, with the checks report.
		vi.advanceTimersByTime(3 * 60_000);
		await harness.send(
			createSnapshot({
				workspaceId: "foo",
				board: createBoard({ review: [DEV] }),
				selectedAgentId: "claude",
				sessions: [{ taskId: DEV.id, state: "awaiting_review", stateChangedAt: T0 + 60_000, live: true }],
			}),
		);
		expect(createdTasks(harness.actions)[0]?.prompt).toContain("- Result: PASS");
	});
});

describe("buildQaChecksReport", () => {
	it("says nothing without checks or while they run", () => {
		const input = { snapshot: "abcdef1234", baseRef: "main" };
		expect(buildQaChecksReport({ ...input, status: { kind: "off", reason: "off" } })).toBeNull();
		expect(buildQaChecksReport({ ...input, status: { kind: "waiting", since: 0, deadline: 1 } })).toBeNull();
		expect(buildQaChecksReport({ ...input, status: { kind: "finished", checks: null } })).toContain(
			"no details were recorded",
		);
	});
});
