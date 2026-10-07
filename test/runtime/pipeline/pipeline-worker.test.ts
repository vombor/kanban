import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ChecksResult } from "../../../src/pipeline/checks";
import { createPipelineWorkerHarness, createSnapshot } from "../../utilities/pipeline-worker";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const QA_WORKSPACE = { landing: { mode: "qa" }, kit: { name: "team" } };

describe("pipeline worker", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	const createHarness = (...args: Parameters<typeof createPipelineWorkerHarness>) => {
		const harness = createPipelineWorkerHarness(...args);
		harnesses.push(harness);
		return harness;
	};
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	it("logs a watching record and one decision per submitted card, and an unchanged answer only once", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		const snapshot = createSnapshot({
			workspaceId: "foo",
			board: createBoard({ review: [createCard({ id: "dev-1" })], in_progress: [createCard({ id: "dev-2" })] }),
			selectedAgentId: "claude",
		});

		await harness.send(snapshot);
		await harness.send(snapshot);

		const records = harness.readDecisions("foo");
		expect(records.map((record) => [record.stage, record.taskId])).toEqual([
			["worker", null],
			["qa_gate", "dev-1"],
		]);
		expect(records[0]?.note).toContain("watching: landing qa, kit team");
		expect(records[1]).toMatchObject({
			kit: "team",
			landingMode: "qa",
			shadow: false,
			role: "dev",
			effectiveAgent: { agentId: "claude", source: "selected" },
			answer: { kind: "qa", agentId: "codex" },
			// The QA gate itself is a later card: the skeleton decides and records only.
			outcome: "not_implemented",
		});
		expect(harness.messages).toContainEqual({ type: "evaluated", workspaceId: "foo", decisions: 1, logged: 0 });
		expect(harness.events).toEqual([]);
	});

	it("marks decisions on a shadow workspace as shadow", async () => {
		const harness = createHarness({
			config: { workspaces: { foo: { ...QA_WORKSPACE, pipeline: { shadow: true } } } },
		});

		await harness.send(
			createSnapshot({
				workspaceId: "foo",
				board: createBoard({ review: [createCard({ id: "dev-1" })] }),
				selectedAgentId: "claude",
			}),
		);

		expect(harness.readCardDecisions("foo")).toMatchObject([{ shadow: true, outcome: "shadow" }]);
	});

	it("skips cards without work and cards the auto-review reconciler owns; never QAs a non-dev role", async () => {
		const harness = createHarness({
			config: { workspaces: { foo: QA_WORKSPACE } },
			hasWork: (card) => card.id !== "planning",
		});

		await harness.send(
			createSnapshot({
				workspaceId: "foo",
				board: createBoard({
					review: [
						createCard({ id: "planning" }),
						createCard({ id: "auto-commit", autoReviewEnabled: true, autoReviewMode: "commit" }),
						createCard({ id: "qa-mode", autoReviewEnabled: true, autoReviewMode: "qa" }),
						createCard({ id: "qa-card", role: "qa" }),
						// Made by the legacy kit before cutover: no role, only its "QA<n> <devId>:" title.
						createCard({ id: "f00d1", title: "QA2 dead1: Add a wishlist page", agentId: "codex" }),
					],
				}),
				selectedAgentId: "claude",
			}),
		);

		const decisions = harness.readCardDecisions("foo");
		expect(decisions.map((decision) => decision.taskId)).toEqual(["qa-mode", "qa-card", "f00d1"]);
		expect(decisions[1]).toMatchObject({ role: "qa", answer: { kind: "none" }, outcome: "none" });
		expect(decisions[2]).toMatchObject({ role: "qa", answer: { kind: "none" }, outcome: "none" });
	});

	it("picks up a landing-mode or kit change on the next snapshot, with no restart", async () => {
		const harness = createHarness({ config: {} });
		const snapshot = createSnapshot({
			workspaceId: "foo",
			board: createBoard({ review: [createCard({ id: "dev-1" })] }),
			selectedAgentId: "claude",
		});

		await harness.send(snapshot);
		expect(harness.readDecisions("foo")).toEqual([]);

		harness.setConfig({ workspaces: { foo: { landing: { mode: "qa" } } } });
		await harness.send(snapshot);
		expect(harness.readCardDecisions("foo")).toMatchObject([{ kit: "default", answer: { kind: "none" } }]);

		harness.setConfig({ workspaces: { foo: QA_WORKSPACE } });
		await harness.send(snapshot);
		expect(harness.readCardDecisions("foo").at(-1)).toMatchObject({ kit: "team", answer: { kind: "qa" } });

		harness.setConfig({ workspaces: { foo: QA_WORKSPACE }, pipeline: { paused: true } });
		const before = harness.readDecisions("foo").length;
		await harness.send(snapshot);
		expect(harness.readDecisions("foo")).toHaveLength(before);
		expect(harness.messages).toContainEqual({ type: "log", message: "pipeline foo: not watched any more" });
	});

	it("falls back to the default kit when the workspace's kit doesn't resolve, and says so once", async () => {
		const harness = createHarness({
			config: { workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "missing" } } } },
		});
		const snapshot = createSnapshot({
			workspaceId: "foo",
			board: createBoard({ review: [createCard({ id: "dev-1" })] }),
			selectedAgentId: "claude",
		});

		await harness.send(snapshot);
		await harness.send(snapshot);

		expect(harness.readCardDecisions("foo")).toMatchObject([{ kit: "default", answer: { kind: "none" } }]);
		const kitIssues = harness.messages.filter(
			(message) => message.type === "log" && message.message.includes('unknown kit "missing"'),
		);
		expect(kitIssues).toHaveLength(1);
	});

	it("imports the legacy checks-state.json once and reads FAIL rounds and handbacks from it", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		const legacyPath = `${harness.legacyDir}/foo/checks-state.json`;
		mkdirSync(dirname(legacyPath), { recursive: true });
		writeFileSync(
			legacyPath,
			JSON.stringify({
				_qaflow: { since: "2026-10-05T03:01:03.576Z" },
				"dev-1": {
					snapshot: "abc",
					qaflow: { lastRound: 2, failRounds: [1, 2], handbacks: [{ at: "x", extraRounds: 2 }] },
				},
				"old-1": "deadbeef",
			}),
		);

		await harness.send(
			createSnapshot({
				workspaceId: "foo",
				board: createBoard({ review: [createCard({ id: "dev-1" })] }),
				selectedAgentId: "claude",
			}),
		);

		const state = JSON.parse(readFileSync(harness.statePath("foo"), "utf8"));
		expect(state).toMatchObject({
			version: 1,
			since: "2026-10-05T03:01:03.576Z",
			importedFrom: legacyPath,
			cards: { "dev-1": { snapshot: "abc" }, "old-1": { snapshot: "deadbeef" } },
		});
		expect(harness.readCardDecisions("foo")[0]?.note).toMatch(/^round 3:/u);
		// Read-only: the legacy file is untouched.
		expect(JSON.parse(readFileSync(legacyPath, "utf8"))["old-1"]).toBe("deadbeef");
	});

	it("logs the submission stage's records once per stage, next to the QA gate's", async () => {
		const harness = createHarness({
			config: { workspaces: { foo: QA_WORKSPACE } },
			inspectSubmission: async (_context, { card }) => ({
				hasWork: true,
				records: [
					{ stage: "snapshot", outcome: "acted", note: `snapshot of ${card.id}` },
					{ stage: "checks", outcome: "acted", note: "checks queued" },
				],
			}),
		});
		const snapshot = createSnapshot({
			workspaceId: "foo",
			board: createBoard({ review: [createCard({ id: "dev-1" })] }),
			selectedAgentId: "claude",
		});

		await harness.send(snapshot);
		await harness.send(snapshot);

		expect(harness.readDecisions("foo").map((record) => [record.stage, record.taskId])).toEqual([
			["worker", null],
			["snapshot", "dev-1"],
			["checks", "dev-1"],
			["qa_gate", "dev-1"],
		]);
		expect(harness.readCardDecisions("foo", "snapshot")[0]).toMatchObject({
			role: "dev",
			effectiveAgent: { agentId: "claude", source: "selected" },
			answer: null,
			note: "snapshot of dev-1",
		});
	});

	it("treats the legacy kit's QA and calibration cards (no role) as what they are, not as dev cards", async () => {
		const inspected: string[] = [];
		const harness = createHarness({
			config: { workspaces: { foo: QA_WORKSPACE } },
			inspectSubmission: async (_context, { card, effective }) => {
				inspected.push(`${card.id}:${effective.role}`);
				return { hasWork: true, records: [] };
			},
		});

		await harness.send(
			createSnapshot({
				workspaceId: "foo",
				board: createBoard({
					review: [
						createCard({ id: "qa-1", title: "QA abc12: Add a button" }),
						createCard({ id: "cal-1", title: "QA-CAL v7 case 1" }),
					],
				}),
				selectedAgentId: "claude",
			}),
		);

		expect(inspected).toEqual(["qa-1:qa", "cal-1:calibration"]);
		expect(harness.readCardDecisions("foo")).toMatchObject([
			{ taskId: "qa-1", role: "qa", answer: { kind: "none" } },
			{ taskId: "cal-1", role: "calibration", answer: { kind: "none" } },
		]);
	});

	it("records a checks result in the card's state, the QA log and the decision log", async () => {
		const recorders: Array<(result: ChecksResult) => Promise<void>> = [];
		const harness = createHarness({
			config: { workspaces: { foo: QA_WORKSPACE } },
			createChecks: (onResult) => {
				recorders.push(onResult);
				return { enqueue: () => "queued", idle: async () => {}, close: () => {} };
			},
		});
		const result: ChecksResult = {
			request: {
				workspaceId: "foo",
				repoPath: "/repos/foo",
				taskId: "dev-1",
				title: "Add a button",
				baseRef: "main",
				snapshot: "0123456789abcdef",
				scripts: ["test"],
			},
			verdict: "FAIL",
			harness: false,
			steps: [
				{ name: "install", ok: true, ms: 2000 },
				{ name: "test", ok: false, ms: 3000, text: "Error: expected 1 to be 2" },
			],
			logsDir: "/tmp/kanban-checks/foo/dev-1/.checks",
			startedAt: Date.parse("2026-10-07T10:00:00.000Z"),
			finishedAt: Date.parse("2026-10-07T10:01:00.000Z"),
			timeoutMin: 15,
			error: null,
		};

		expect(recorders).toHaveLength(1);
		await recorders[0]?.(result);

		const state = JSON.parse(readFileSync(harness.statePath("foo"), "utf8"));
		expect(state.cards["dev-1"]).toMatchObject({
			snapshot: "0123456789abcdef",
			version: 2,
			harness: false,
			checks: {
				verdict: "FAIL",
				at: "2026-10-07T10:01:00.000Z",
				steps: [
					{ name: "install", status: "ok", ms: 2000 },
					{ name: "test", status: "fail", ms: 3000 },
				],
			},
		});
		const qaLog = readFileSync(harness.qaLogPath("foo"), "utf8");
		expect(qaLog).toContain("## dev-1 Add a button — checks FAIL");
		expect(qaLog).toContain("Error: expected 1 to be 2");
		expect(harness.readCardDecisions("foo", "checks")).toMatchObject([
			{ taskId: "dev-1", kit: "team", outcome: "acted", note: "checks FAIL on 01234567: install=ok test=fail" },
		]);
	});
});
