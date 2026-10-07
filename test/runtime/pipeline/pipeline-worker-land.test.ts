import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeTaskTrashResponse } from "../../../src/core/api-contract";
import { loadKitCatalog } from "../../../src/kits/resolve-kit";
import { createPipelineDecisionLog } from "../../../src/pipeline/decision-log";
import { createPipelineEventBus, type PipelineEventMap } from "../../../src/pipeline/events";
import { createPipelineStateStore } from "../../../src/pipeline/pipeline-state";
import { createPipelineWorker } from "../../../src/pipeline/worker";
import { createPipelineWorkerHost, type PipelineWorkerChild } from "../../../src/pipeline/worker-host";
import type { PipelineHostMessage, PipelineWorkerMessage } from "../../../src/pipeline/worker-protocol";
import { createSnapshot } from "../../utilities/pipeline-worker";
import { createTempDir } from "../../utilities/temp-dir";
import { createBoard } from "../../utilities/workspace-state-store";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const QA_FOO = { workspaces: { foo: { landing: { mode: "qa" } } } };

function trashed(taskId: string): RuntimeTaskTrashResponse {
	return {
		ok: true,
		status: "trashed",
		taskId,
		previousColumnId: "review",
		readyTaskIds: [],
		autoStartedTasks: [],
		worktreeDeleted: true,
		landing: { decision: "landed", baseRef: "main", commit: "abc" },
	};
}

describe("pipeline worker: acting through the server", () => {
	let temp: ReturnType<typeof createTempDir> | null = null;
	afterEach(() => {
		temp?.cleanup();
		temp = null;
	});

	function createWorker() {
		temp = createTempDir("kanban-pipeline-land-");
		const root = temp.path;
		const messages: PipelineWorkerMessage[] = [];
		const landed: Array<PipelineEventMap["landed"]> = [];
		const bus = createPipelineEventBus();
		bus.on("landed", (event) => {
			landed.push(event);
		});
		const store = createPipelineStateStore({
			now: () => NOW,
			getStatePath: (workspaceId) => join(root, "data", workspaceId, "pipeline-state.json"),
			getLegacyChecksStatePaths: () => [],
		});
		const preserveWork = vi.fn(async () => "commit");
		const worker = createPipelineWorker({
			send: (message) => messages.push(message),
			readConfig: async () => parsePipelineConfig(QA_FOO),
			loadCatalog: async () => await loadKitCatalog(join(root, "kits")),
			store,
			decisionLog: createPipelineDecisionLog({ getLogPath: (id) => join(root, "data", id, "decisions.jsonl") }),
			bus,
			inspectSubmission: async () => ({ hasWork: false, records: [] }),
			loadAgentDefaultModels: async () => ({}),
			preserveWork,
			now: () => NOW,
		});
		/** Answers every finishTask request the worker has sent so far. */
		const answerRequests = async (answer: (taskId: string) => RuntimeTaskTrashResponse) => {
			for (const message of messages.splice(0)) {
				if (message.type === "finishTask") {
					await worker.handle({
						type: "finishTaskResult",
						requestId: message.requestId,
						result: answer(message.request.taskId),
					});
				}
			}
		};
		return { worker, messages, landed, store, preserveWork, answerRequests };
	}

	it("finishTask sends a request and resolves with the server's answer", async () => {
		const { worker, messages, answerRequests } = createWorker();

		const pending = worker.finishTask({ workspaceId: "foo", taskId: "dev-1", landing: "land", trigger: "pipeline" });
		expect(messages).toEqual([
			{
				type: "finishTask",
				requestId: 1,
				request: { workspaceId: "foo", taskId: "dev-1", landing: "land", trigger: "pipeline" },
			},
		]);
		await answerRequests(trashed);

		await expect(pending).resolves.toMatchObject({ ok: true, landing: { decision: "landed" } });
		worker.close();
	});

	it("rejects pending requests when it closes", async () => {
		const { worker } = createWorker();

		const pending = worker.finishTask({ workspaceId: "foo", taskId: "dev-1", landing: "land", trigger: "pipeline" });
		worker.close();

		await expect(pending).rejects.toThrow(/shutting down/u);
	});

	it("emits landed for kit features when the server reports a land", async () => {
		const { worker, landed } = createWorker();
		const event: PipelineEventMap["landed"] = {
			workspaceId: "foo",
			taskId: "dev-1",
			at: NOW,
			baseRef: "main",
			commit: "abc",
			via: "approved",
		};

		await worker.handle({ type: "landed", event });

		expect(landed).toEqual([event]);
		worker.close();
	});

	it("releases a hold through a hold_release finishTask on a watched workspace", async () => {
		const { worker, messages, store, preserveWork, answerRequests } = createWorker();
		await worker.handle({
			type: "snapshot",
			snapshot: createSnapshot({ workspaceId: "foo", board: createBoard({}), selectedAgentId: "claude" }),
		});
		await worker.idle();
		await store.update("foo", (state) => {
			state.cards["dev-1"] = { hold: { group: "g1", at: "2026-10-07T11:00:00.000Z", round: 1 } };
			return state;
		});
		messages.splice(0);

		expect(await worker.releaseHold("bar", { taskId: "dev-1", decision: "land" })).toMatchObject({ ok: false });

		const pending = worker.releaseHold("foo", { taskId: "dev-1", decision: "discard", tag: "preserve/dev-1-m" });
		await vi.waitFor(() => expect(messages.some((message) => message.type === "finishTask")).toBe(true));
		expect(messages.find((message) => message.type === "finishTask")).toMatchObject({
			request: { workspaceId: "foo", taskId: "dev-1", landing: "discard", trigger: "hold_release" },
		});
		await answerRequests(trashed);

		await expect(pending).resolves.toMatchObject({ ok: true, tag: "preserve/dev-1-m" });
		expect(preserveWork).toHaveBeenCalledWith({
			workspacePath: "/repos/foo",
			taskId: "dev-1",
			tag: "preserve/dev-1-m",
		});
		expect((await store.peek("foo"))?.cards["dev-1"]?.hold).toBeUndefined();
		worker.close();
	});
});

describe("pipeline worker host: requests from the worker", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function createChild() {
		const listeners: Array<(message: unknown) => void> = [];
		const child: PipelineWorkerChild & { sent: PipelineHostMessage[]; emit: (message: unknown) => void } = {
			pid: 4242,
			sent: [],
			send: (message) => {
				child.sent.push(message);
			},
			onMessage: (listener) => {
				listeners.push(listener);
			},
			onExit: () => {},
			kill: () => {},
			emit: (message) => {
				for (const listener of listeners) {
					listener(message);
				}
			},
		};
		return child;
	}

	it("runs finishTask on the server, answers the worker, and forwards lands", async () => {
		vi.useFakeTimers();
		const child = createChild();
		const finishTask = vi.fn(async (request: { taskId: string }) => trashed(request.taskId));
		const host = createPipelineWorkerHost({
			listWorkspaces: () => [{ workspaceId: "foo", workspacePath: "/repos/foo" }],
			buildSnapshot: async () => null,
			readConfig: async () => parsePipelineConfig(QA_FOO),
			spawnWorker: () => child,
			finishTask,
			log: () => {},
		});
		host.start();
		await vi.advanceTimersByTimeAsync(0);

		const request = { workspaceId: "foo", taskId: "dev-1", landing: "land" as const, trigger: "pipeline" as const };
		child.emit({ type: "finishTask", requestId: 7, request });
		await vi.advanceTimersByTimeAsync(0);
		const event: PipelineEventMap["landed"] = {
			workspaceId: "foo",
			taskId: "dev-1",
			at: NOW,
			baseRef: "main",
			commit: "abc",
			via: "qa",
		};
		host.notifyLanded(event);

		expect(finishTask).toHaveBeenCalledWith(request);
		expect(child.sent).toContainEqual({ type: "finishTaskResult", requestId: 7, result: trashed("dev-1") });
		expect(child.sent).toContainEqual({ type: "landed", event });
		await host.close();
	});

	it("answers a failed request instead of leaving the worker waiting", async () => {
		vi.useFakeTimers();
		const child = createChild();
		const host = createPipelineWorkerHost({
			listWorkspaces: () => [{ workspaceId: "foo", workspacePath: "/repos/foo" }],
			buildSnapshot: async () => null,
			readConfig: async () => parsePipelineConfig(QA_FOO),
			spawnWorker: () => child,
			finishTask: async () => {
				throw new Error("workspace gone");
			},
			log: () => {},
		});
		host.start();
		await vi.advanceTimersByTimeAsync(0);

		child.emit({
			type: "finishTask",
			requestId: 1,
			request: { workspaceId: "foo", taskId: "dev-1", landing: "land", trigger: "pipeline" },
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(child.sent).toContainEqual({
			type: "finishTaskResult",
			requestId: 1,
			result: expect.objectContaining({ ok: false, status: "failed", error: "workspace gone" }),
		});
		await host.close();
	});
});
