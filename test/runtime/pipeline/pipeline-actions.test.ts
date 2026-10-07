import { describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { PipelineActionRequest, PipelineActionResult } from "../../../src/pipeline/actions";
import { createPipelineWorkerHost, type PipelineWorkerChild } from "../../../src/pipeline/worker-host";
import type { PipelineHostMessage, PipelineWorkerMessage } from "../../../src/pipeline/worker-protocol";
import { createPipelineActionRunner } from "../../../src/server/pipeline-actions";
import { createSnapshot } from "../../utilities/pipeline-worker";
import {
	createBoard,
	createCard,
	createFakeTaskTrashWorkflowDependencies,
	createWorkspaceStateStore,
	findCardInBoard,
} from "../../utilities/workspace-state-store";

const SCOPE = { workspaceId: "foo", workspacePath: "/repos/foo" };

function createRunner(columns: Parameters<typeof createBoard>[0]) {
	const store = createWorkspaceStateStore({ board: createBoard(columns), sessions: {}, revision: 1 });
	const fakes = createFakeTaskTrashWorkflowDependencies(store);
	const onBoardMutated = vi.fn();
	const run = createPipelineActionRunner({
		mutateWorkspaceState: store.mutateWorkspaceState,
		ensureTaskWorktree: fakes.ensureTaskWorktree,
		startTaskSession: fakes.startTaskSession,
		onBoardMutated,
	});
	return { store, fakes, onBoardMutated, run };
}

describe("pipeline actions on the server", () => {
	it("creates a QA card in Backlog with its role and reviewsTaskId, never auto-reviewed", async () => {
		const { store, run, onBoardMutated } = createRunner({ review: [createCard({ id: "d1111" })] });

		const result = await run({
			...SCOPE,
			kind: "createTask",
			task: {
				taskId: "qa001",
				title: "QA d1111: Wishlist",
				prompt: "You are the QA reviewer (round 1) for Kanban dev card d1111",
				role: "qa",
				reviewsTaskId: "d1111",
				agentId: "codex",
				baseRef: "main",
			},
		});

		expect(result).toEqual({ ok: true, detail: "qa001" });
		expect(findCardInBoard(store.stored.board, "qa001")).toMatchObject({
			columnId: "backlog",
			card: { role: "qa", reviewsTaskId: "d1111", agentId: "codex", autoReviewEnabled: false },
		});
		expect(onBoardMutated).toHaveBeenCalledWith(expect.objectContaining(SCOPE));
	});

	it("refuses a task id that already exists", async () => {
		const { run } = createRunner({ backlog: [createCard({ id: "qa001" })] });
		const result = await run({
			...SCOPE,
			kind: "createTask",
			task: { taskId: "qa001", title: "x", prompt: "x", role: "qa", agentId: "codex", baseRef: "main" },
		});
		expect(result).toEqual({ ok: false, error: 'Task "qa001" already exists.' });
	});

	it("starts a Backlog card with the card's agent and settings, then moves it to In Progress", async () => {
		const qa = createCard({
			id: "qa001",
			role: "qa",
			agentId: "cline",
			agentSettings: { providerId: "bedrock", modelId: "haiku" },
		});
		const { store, fakes, run } = createRunner({ backlog: [qa] });

		expect(await run({ ...SCOPE, kind: "startTask", taskId: "qa001" })).toEqual({ ok: true });
		expect(fakes.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining(SCOPE),
			expect.objectContaining({
				taskId: "qa001",
				agentId: "cline",
				agentSettings: { providerId: "bedrock", modelId: "haiku" },
			}),
		);
		expect(findCardInBoard(store.stored.board, "qa001")?.columnId).toBe("in_progress");
	});

	it("does not start a card outside Backlog", async () => {
		const { fakes, run } = createRunner({ in_progress: [createCard({ id: "qa001" })] });
		expect(await run({ ...SCOPE, kind: "startTask", taskId: "qa001" })).toEqual({
			ok: false,
			error: "task qa001 is not in Backlog",
		});
		expect(fakes.startTaskSession).not.toHaveBeenCalled();
	});
});

describe("QA gate card actions over the worker's request channel", () => {
	function createFakeChild(): PipelineWorkerChild & {
		sent: PipelineHostMessage[];
		emit: (message: PipelineWorkerMessage) => void;
	} {
		const listeners: Array<(message: unknown) => void> = [];
		const child = {
			pid: 4242,
			sent: [] as PipelineHostMessage[],
			send: (message: PipelineHostMessage) => {
				child.sent.push(message);
			},
			onMessage: (listener: (message: unknown) => void) => {
				listeners.push(listener);
			},
			onExit: () => {},
			kill: () => {},
			emit: (message: PipelineWorkerMessage) => {
				for (const listener of listeners) {
					listener(message);
				}
			},
		};
		return child;
	}

	const createHost = async (
		runAction: (request: PipelineActionRequest) => Promise<PipelineActionResult>,
		config: unknown = { workspaces: { foo: { landing: { mode: "qa" } } } },
	) => {
		const child = createFakeChild();
		const handleWatchdogRequest = vi.fn(async () => ({ ok: true, status: "delivered" }));
		const host = createPipelineWorkerHost({
			listWorkspaces: () => [
				{ workspaceId: "foo", workspacePath: "/repos/foo" },
				{ workspaceId: "kanban-2uge", workspacePath: "/repos/kanban-2uge" },
			],
			buildSnapshot: async (workspaceId) =>
				createSnapshot({ workspaceId, board: createBoard({}), selectedAgentId: "claude" }),
			readConfig: async () => parsePipelineConfig(config),
			spawnWorker: () => child,
			runAction,
			handleWatchdogRequest,
			log: () => {},
		});
		await host.sweep();
		return { host, child, handleWatchdogRequest };
	};

	const waitForResponse = async (child: ReturnType<typeof createFakeChild>, id: number) => {
		await vi.waitFor(() => {
			expect(child.sent.some((message) => message.type === "response" && message.id === id)).toBe(true);
		});
		return child.sent.find((message) => message.type === "response" && message.id === id);
	};

	const startRequest: PipelineActionRequest = {
		kind: "startTask",
		workspaceId: "foo",
		workspacePath: "/repos/foo",
		taskId: "qa001",
	};

	it("runs a card action for a pipeline workspace; watchdog kinds still go to the watchdog handler", async () => {
		const runAction = vi.fn(async (): Promise<PipelineActionResult> => ({ ok: true }));
		const { host, child, handleWatchdogRequest } = await createHost(runAction);

		child.emit({ type: "request", id: 7, request: startRequest });
		child.emit({
			type: "request",
			id: 8,
			request: { kind: "deliverInput", workspaceId: "foo", taskId: "qa001", text: "x" },
		});

		expect(await waitForResponse(child, 7)).toEqual({ type: "response", id: 7, ok: true, result: { ok: true } });
		expect(await waitForResponse(child, 8)).toMatchObject({ ok: true });
		expect(runAction).toHaveBeenCalledWith(startRequest);
		expect(handleWatchdogRequest).toHaveBeenCalledTimes(1);
		await host.close();
	});

	it("refuses a card action for a workspace that doesn't run the pipeline, and reports a failed one", async () => {
		const runAction = vi.fn(async (): Promise<PipelineActionResult> => ({ ok: false, error: "not in Backlog" }));
		const { host, child } = await createHost(runAction);

		child.emit({
			type: "request",
			id: 9,
			request: { ...startRequest, workspaceId: "kanban-2uge", workspacePath: "/repos/kanban-2uge" },
		});
		child.emit({ type: "request", id: 10, request: startRequest });

		expect(await waitForResponse(child, 9)).toEqual({
			type: "response",
			id: 9,
			ok: false,
			error: "workspace kanban-2uge does not run the pipeline",
		});
		expect(await waitForResponse(child, 10)).toEqual({
			type: "response",
			id: 10,
			ok: false,
			error: "not in Backlog",
		});
		expect(runAction).toHaveBeenCalledTimes(1);
		await host.close();
	});

	it("with the watchdog on, a landing-off workspace gets snapshots and watchdog actions but no card actions", async () => {
		const runAction = vi.fn(async (): Promise<PipelineActionResult> => ({ ok: true }));
		const { host, child, handleWatchdogRequest } = await createHost(runAction, {
			watchdog: { mode: "on" },
			workspaces: { foo: { landing: { mode: "qa" } } },
		});
		child.emit({ type: "ready", pid: 4242 });
		await vi.waitFor(() => {
			const snapshots = child.sent.flatMap((message) =>
				message.type === "snapshot" ? [message.snapshot.workspaceId] : [],
			);
			expect(snapshots.sort()).toEqual(["foo", "kanban-2uge"]);
		});

		const offScope = { workspaceId: "kanban-2uge", workspacePath: "/repos/kanban-2uge" };
		child.emit({ type: "request", id: 11, request: { ...startRequest, ...offScope } });
		child.emit({
			type: "request",
			id: 12,
			request: {
				...offScope,
				kind: "createTask",
				task: { taskId: "qa002", title: "QA", prompt: "x", role: "qa", agentId: "claude", baseRef: "main" },
			},
		});
		child.emit({
			type: "request",
			id: 13,
			request: { kind: "deliverInput", workspaceId: "kanban-2uge", taskId: "t1", text: "x" },
		});
		child.emit({ type: "request", id: 14, request: startRequest });

		const refused = { ok: false, error: "workspace kanban-2uge does not run the pipeline" };
		expect(await waitForResponse(child, 11)).toMatchObject(refused);
		expect(await waitForResponse(child, 12)).toMatchObject(refused);
		expect(await waitForResponse(child, 13)).toMatchObject({ ok: true });
		expect(await waitForResponse(child, 14)).toMatchObject({ ok: true, result: { ok: true } });
		expect(handleWatchdogRequest).toHaveBeenCalledWith({
			kind: "deliverInput",
			workspaceId: "kanban-2uge",
			taskId: "t1",
			text: "x",
		});
		expect(runAction).toHaveBeenCalledTimes(1);
		expect(runAction).toHaveBeenCalledWith(startRequest);
		await host.close();
	});
});
