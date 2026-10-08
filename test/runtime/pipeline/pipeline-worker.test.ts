import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { ChecksResult } from "../../../src/pipeline/checks";
import type { WatchdogActions } from "../../../src/pipeline/watchdog/actions";
import { createPipelineWorker } from "../../../src/pipeline/worker";
import type { PipelineWorkerMessage } from "../../../src/pipeline/worker-protocol";
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
		await harness.send(snapshot);

		// The creation, then (once) that the snapshot already has its QA card.
		const records = harness.readDecisions("foo");
		expect(records.map((record) => [record.stage, record.taskId])).toEqual([
			["worker", null],
			["qa_gate", "dev-1"],
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
			// The QA gate created the QA card (qa-gate.test.ts covers it).
			outcome: "acted",
		});
		expect(records[1]?.note).toContain("QA card qa001 was created for snapshot snap-dev");
		expect(records[2]).toMatchObject({ outcome: "none" });
		expect(records[2]?.note).toContain("snapshot snap-dev already has QA card qa001 (round 1, created ");
		expect(records[2]?.note).toContain("queued); no new QA card");
		expect(harness.messages).toContainEqual({ type: "evaluated", workspaceId: "foo", decisions: 1, logged: 0 });
		expect(harness.events).toEqual([]);
	});

	it("with recovery report-only, never QAs a Review dev card whose session the restart cut off (interrupted at startup)", async () => {
		const serverStartedAt = Date.parse("2026-10-07T09:59:00.000Z");
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		const send = async (state: "interrupted" | "awaiting_review", startedAt: number) =>
			await harness.send({
				...createSnapshot({
					workspaceId: "foo",
					board: createBoard({ review: [createCard({ id: "dev-1" })] }),
					selectedAgentId: "claude",
					sessions: [{ taskId: "dev-1", state, startedAt, live: false }],
				}),
				serverStartedAt,
			});

		await send("interrupted", serverStartedAt - 60_000);
		expect(harness.actions).toEqual([]);
		expect(harness.readCardDecisions("foo")).toMatchObject([
			{ taskId: "dev-1", outcome: "none", note: expect.stringContaining("cut off by the Kanban restart") },
		]);

		// Once it has run again under this server and finished, it is QA'd as usual.
		await send("awaiting_review", serverStartedAt + 1_000);
		expect(harness.actions.filter((action) => action.kind === "createTask")).toHaveLength(1);
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
			// The second evaluation: the snapshot already has its QA card.
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

	it("never snapshots, QAs or reworks a plan card: no QA card, only a dev card next to it gets one", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		const snapshot = createSnapshot({
			workspaceId: "foo",
			board: createBoard({
				review: [
					createCard({ id: "plan1", role: "plan", startInPlanMode: true, agentId: "claude" }),
					createCard({ id: "dev-1" }),
				],
			}),
			selectedAgentId: "claude",
		});

		await harness.send(snapshot);

		expect(harness.readCardDecisions("foo")).toMatchObject([
			{ taskId: "plan1", role: "plan", answer: { kind: "none", reason: "plan cards are never QA'd" } },
			{ taskId: "dev-1", role: "dev", answer: { kind: "qa" } },
		]);
		const created = harness.actions.filter((action) => action.kind === "createTask");
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ task: { role: "qa", reviewsTaskId: "dev-1" } });
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

	it("leaves a Review card recovery holds out of the snapshot and QA gate (autoland's onDevReview order)", async () => {
		const inspected: string[] = [];
		const harness = createHarness({
			config: { workspaces: { foo: QA_WORKSPACE } },
			inspectSubmission: async (_context, { card }) => {
				inspected.push(card.id);
				return { hasWork: true, records: [] };
			},
			createRecovery: () => ({ evaluate: async () => [], forget: () => {}, idle: async () => {}, close: () => {} }),
		});
		const legacyPath = `${harness.legacyDir}/foo/checks-state.json`;
		mkdirSync(dirname(legacyPath), { recursive: true });
		writeFileSync(
			legacyPath,
			JSON.stringify({
				"dev-retry": { qaflow: { retryAt: "2026-10-07T10:05:00.000Z" } },
				"dev-orphan": { qaflow: { orphan: { at: "x", kanbanStart: "y", kind: "dev" } } },
			}),
		);
		await harness.send(
			createSnapshot({
				workspaceId: "foo",
				board: createBoard({
					review: [
						createCard({ id: "dev-retry" }),
						createCard({ id: "dev-orphan" }),
						createCard({ id: "dev-ok" }),
					],
				}),
				selectedAgentId: "claude",
			}),
		);
		expect(inspected).toEqual(["dev-ok"]);
		expect(harness.readCardDecisions("foo").map((record) => record.taskId)).toEqual(["dev-ok"]);
	});

	it("runs recovery before the QA gate, so a card it marks in this evaluation is not QA'd", async () => {
		const inspected: string[] = [];
		let statePath = "";
		const harness = createHarness({
			config: { workspaces: { foo: QA_WORKSPACE }, pipeline: { recovery: { mode: "on" } } },
			inspectSubmission: async (_context, { card }) => {
				inspected.push(card.id);
				return { hasWork: true, records: [] };
			},
			// Stands in for restart recovery marking an interrupted orphan in Review.
			createRecovery: () => ({
				evaluate: async () => {
					const state = JSON.parse(readFileSync(statePath, "utf8"));
					state.cards["dev-orphan"] = { qaflow: { orphan: { at: "x", kanbanStart: "y", kind: "dev" } } };
					writeFileSync(statePath, JSON.stringify(state));
					return [];
				},
				forget: () => {},
				idle: async () => {},
				close: () => {},
			}),
		});
		statePath = harness.statePath("foo");
		await harness.send(
			createSnapshot({
				workspaceId: "foo",
				board: createBoard({ review: [createCard({ id: "dev-orphan" }), createCard({ id: "dev-ok" })] }),
				selectedAgentId: "claude",
			}),
		);
		expect(inspected).toEqual(["dev-ok"]);
	});

	it("sends recovery's actions as watchdog and card-action requests and resumes with the answers", async () => {
		const results: unknown[] = [];
		const harness = createHarness({
			config: { pipeline: { recovery: { mode: "on" } } },
			createRecovery: (act) => ({
				evaluate: async (input) => {
					const workspaceId = input.snapshot.workspaceId;
					results.push(await act(workspaceId, { kind: "input", taskId: "dev-1", data: "\u001b" }));
					results.push(
						await act(workspaceId, {
							kind: "resume",
							taskId: "dev-1",
							prompt: "Go on.",
							agentId: "claude",
							continueConversation: true,
						}),
					);
					return [];
				},
				forget: () => {},
				idle: async () => {},
				close: () => {},
			}),
		});
		const snapshot = createSnapshot({
			workspaceId: "kanban-2uge",
			board: createBoard({}),
			selectedAgentId: "claude",
		});
		const handled = harness.worker.handle({ type: "snapshot", snapshot });
		const answer = async (index: number, result: unknown) => {
			await vi.waitFor(() =>
				expect(harness.messages.filter((message) => message.type === "request").length).toBeGreaterThan(index),
			);
			const request = harness.messages.filter((message) => message.type === "request")[index];
			await harness.worker.handle({
				type: "response",
				id: request?.type === "request" ? request.id : -1,
				ok: true,
				result,
			});
			return request?.type === "request" ? request.request : null;
		};
		expect(await answer(0, { ok: true })).toEqual({ kind: "interrupt", workspaceId: "kanban-2uge", taskId: "dev-1" });
		expect(await answer(1, { ok: true })).toEqual({
			kind: "resumeTask",
			workspaceId: "kanban-2uge",
			workspacePath: "/repos/kanban-2uge",
			taskId: "dev-1",
			prompt: "Go on.",
			agentId: "claude",
			continueConversation: true,
		});
		await handled;
		expect(results).toEqual([
			{ ok: true, status: "sent" },
			{ ok: true, status: "started" },
		]);
		// Recovery on reaches a landing-off workspace: it is watched, with no QA-gate decisions.
		expect(harness.readDecisions("kanban-2uge").map((record) => record.stage)).toEqual(["worker"]);
		expect(harness.readDecisions("kanban-2uge")[0]?.note).toContain("recovery on");
	});

	it("never evaluates a landing-off workspace while recovery is report-only (the default)", async () => {
		const evaluate = vi.fn(async () => []);
		const harness = createHarness({
			config: {},
			createRecovery: () => ({ evaluate, forget: () => {}, idle: async () => {}, close: () => {} }),
		});
		await harness.send(
			createSnapshot({ workspaceId: "kanban-2uge", board: createBoard({}), selectedAgentId: "claude" }),
		);
		expect(evaluate).not.toHaveBeenCalled();
		expect(harness.readDecisions("kanban-2uge")).toEqual([]);
	});
});

describe("pipeline worker: watchdog requests", () => {
	it("sends the watchdog's requests to the server and resolves them with its responses", async () => {
		const sent: PipelineWorkerMessage[] = [];
		let actions: WatchdogActions | null = null;
		const observed: string[] = [];
		const worker = createPipelineWorker({
			send: (message) => sent.push(message),
			readConfig: async () => parsePipelineConfig({}),
			createWatchdog: (input) => {
				actions = input.actions;
				return {
					observe: (snapshot) => observed.push(snapshot.workspaceId),
					forget: () => {},
					tick: async () => {},
				};
			},
		});
		await worker.handle({
			type: "snapshot",
			snapshot: createSnapshot({ workspaceId: "plain", board: createBoard({}), selectedAgentId: "claude" }),
		});
		expect(observed).toEqual(["plain"]);

		const pending = (actions as WatchdogActions | null)?.request({
			kind: "interrupt",
			workspaceId: "plain",
			taskId: "t1",
		});
		const request = sent.find((message) => message.type === "request");
		expect(request).toEqual({
			type: "request",
			id: 1,
			request: { kind: "interrupt", workspaceId: "plain", taskId: "t1" },
		});
		await worker.handle({ type: "response", id: 1, ok: true, result: { ok: true } });
		await expect(pending).resolves.toEqual({ ok: true });

		const failing = (actions as WatchdogActions | null)?.request({ kind: "sweepProcesses" });
		await worker.handle({ type: "response", id: 2, ok: false, error: "no /proc" });
		await expect(failing).rejects.toThrow("no /proc");
		worker.close();
	});
});
