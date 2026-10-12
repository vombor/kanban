// The worker sends the board's card stages (issue #30) to the server as `cardStages` messages: after each evaluation
// and whenever the checks runner moves on, only when they changed, and only for a landing-`qa` workspace outside
// shadow. Runs the worker with the real QA gate and a fake checks runner whose status each test sets.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimePipelineCardStage } from "../../../src/core/api-contract";
import type { ChecksResult, ChecksRunner, ChecksRunnerStatus } from "../../../src/pipeline/checks";
import { createPipelineWorkerHarness, createSnapshot } from "../../utilities/pipeline-worker";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const T0 = Date.parse("2026-10-11T06:43:23.000Z");
const QA_WORKSPACE = { landing: { mode: "qa" }, kit: { name: "team" } };
const DEV = createCard({ id: "8c28e" });

describe("pipeline worker: card stages for the board", () => {
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

	function setup(config: unknown = { workspaces: { foo: QA_WORKSPACE } }) {
		let status: ChecksRunnerStatus = { running: null, queued: [] };
		let notify: () => void = () => {};
		let onChecksResult: ((result: ChecksResult) => Promise<void>) | null = null;
		const runner: ChecksRunner = {
			enqueue: () => "queued",
			status: () => status,
			idle: async () => {},
			close: () => {},
		};
		const harness = createPipelineWorkerHarness({
			config,
			clock: () => Date.now(),
			checkScripts: () => ["test"],
			createChecks: (onResult, onStatusChange) => {
				onChecksResult = onResult;
				notify = onStatusChange;
				return runner;
			},
		});
		harnesses.push(harness);
		const send = async () => {
			await harness.send(
				createSnapshot({ workspaceId: "foo", board: createBoard({ review: [DEV] }), selectedAgentId: "claude" }),
			);
		};
		const setStatus = async (next: ChecksRunnerStatus) => {
			status = next;
			notify();
			await harness.worker.idle();
		};
		const stageMessages = () =>
			harness.messages.flatMap((message) =>
				message.type === "cardStages" ? [{ workspaceId: message.workspaceId, stages: message.stages }] : [],
			);
		const lastStages = (): RuntimePipelineCardStage[] | undefined => stageMessages().at(-1)?.stages;
		return {
			harness,
			send,
			setStatus,
			stageMessages,
			lastStages,
			finishChecks: async (result: ChecksResult) => {
				await onChecksResult?.(result);
				await harness.worker.idle();
			},
		};
	}

	it("shows the wait for checks, then the running step, then the QA card once the checks are recorded", async () => {
		const { send, setStatus, stageMessages, lastStages, finishChecks } = setup();
		await send();
		expect(lastStages()).toEqual([
			expect.objectContaining({
				taskId: DEV.id,
				kind: "qa_waiting_checks",
				deadline: T0 + 20 * 60_000,
				inFlight: true,
			}),
		]);

		await setStatus({
			running: { workspaceId: "foo", taskId: DEV.id, snapshot: `snap-${DEV.id}`, step: "test", startedAt: T0 },
			queued: [],
		});
		expect(lastStages()).toEqual([
			expect.objectContaining({ kind: "checks_running", label: "Checks running (test)", next: "QA next" }),
		]);
		// An unchanged list is not sent again.
		const sent = stageMessages().length;
		await send();
		await setStatus({
			running: { workspaceId: "foo", taskId: DEV.id, snapshot: `snap-${DEV.id}`, step: "test", startedAt: T0 },
			queued: [],
		});
		expect(stageMessages()).toHaveLength(sent);

		await setStatus({ running: null, queued: [] });
		await finishChecks({
			request: {
				workspaceId: "foo",
				repoPath: "/repos/foo",
				taskId: DEV.id,
				title: DEV.title,
				baseRef: "main",
				snapshot: `snap-${DEV.id}`,
				scripts: ["test"],
			},
			verdict: "PASS",
			harness: false,
			steps: [{ name: "test", command: "npm run -s test", ok: true, ms: 1_000 }],
			logsDir: "/tmp/checks",
			startedAt: T0,
			finishedAt: T0 + 1_000,
			timeoutMin: 15,
			error: null,
		});
		expect(lastStages()).toEqual([
			expect.objectContaining({ kind: "qa_queued", label: "QA r1 queued", qaTaskId: "qa001", inFlight: true }),
		]);
	});

	it("sends nothing for a workspace on landing off, and an empty list once a QA workspace leaves the pipeline", async () => {
		const off = setup({ workspaces: { foo: { landing: { mode: "off" } } } });
		await off.send();
		expect(off.stageMessages()).toEqual([]);

		const { harness, send, stageMessages } = setup();
		await send();
		expect(stageMessages().at(-1)?.stages).toHaveLength(1);
		harness.setConfig({ workspaces: { foo: { landing: { mode: "off" } } } });
		await send();
		expect(stageMessages().at(-1)).toEqual({ workspaceId: "foo", stages: [] });
	});
});
