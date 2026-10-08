import { describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { PipelineActionRequest, PipelineActionResult } from "../../../src/pipeline/actions";
import { RESTART_RESUME_NOTE } from "../../../src/pipeline/recovery-prompts";
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

	it("keeps the issue of a rework sibling it creates", async () => {
		const { store, run } = createRunner({});
		const issue = { provider: "github" as const, repo: "vombor/kanban", number: 3, url: "u", updatedAt: "t" };
		await run({
			...SCOPE,
			kind: "createTask",
			task: { taskId: "s0001", title: "x", prompt: "x", role: "dev", agentId: "codex", baseRef: "main", issue },
		});
		expect(findCardInBoard(store.stored.board, "s0001")?.card.issue).toEqual(issue);
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

	it("resumes an orphaned card with recovery's prompt and agent, from Review to In Progress", async () => {
		const dev = createCard({ id: "dev01", agentSettings: { providerId: "lemonade", modelId: "glm" } });
		const { store, fakes, run, onBoardMutated } = createRunner({ review: [dev] });

		expect(
			await run({ ...SCOPE, kind: "resumeTask", taskId: "dev01", prompt: "Do it.\n\nNOTE", agentId: "cline" }),
		).toEqual({ ok: true, detail: "started, moved to In Progress" });
		expect(fakes.ensureTaskWorktree).toHaveBeenCalled();
		expect(fakes.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining(SCOPE),
			expect.objectContaining({
				taskId: "dev01",
				prompt: "Do it.\n\nNOTE",
				agentId: "cline",
				agentSettings: { providerId: "lemonade", modelId: "glm" },
			}),
		);
		expect(findCardInBoard(store.stored.board, "dev01")?.columnId).toBe("in_progress");
		expect(onBoardMutated).toHaveBeenCalled();
	});

	it("continueConversation resumes the agent's conversation with the note as launch prompt; the card prompt stays", async () => {
		const dev = createCard({ id: "dev01", prompt: "Do the card." });
		const { store, fakes, run } = createRunner({ in_progress: [dev] });

		expect(
			await run({
				...SCOPE,
				kind: "resumeTask",
				taskId: "dev01",
				prompt: RESTART_RESUME_NOTE,
				agentId: "claude",
				continueConversation: true,
			}),
		).toEqual({ ok: true, detail: "started" });
		expect(fakes.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining(SCOPE),
			expect.objectContaining({ prompt: RESTART_RESUME_NOTE, agentId: "claude", resumeFromTrash: true }),
		);
		expect(findCardInBoard(store.stored.board, "dev01")?.card.prompt).toBe("Do the card.");
	});

	it("never sends resumeFromTrash without continueConversation", async () => {
		const { fakes, run } = createRunner({ review: [createCard({ id: "dev01" })] });
		await run({ ...SCOPE, kind: "resumeTask", taskId: "dev01", prompt: "Do it.", agentId: "claude" });
		const input = vi.mocked(fakes.startTaskSession).mock.calls[0]?.[1];
		expect(input).toMatchObject({ prompt: "Do it.", agentId: "claude" });
		expect(input).not.toHaveProperty("resumeFromTrash");
	});

	it("resumes only In Progress and Review cards", async () => {
		const { fakes, run } = createRunner({ backlog: [createCard({ id: "dev01" })] });
		expect(await run({ ...SCOPE, kind: "resumeTask", taskId: "dev01", prompt: "x", agentId: "cline" })).toEqual({
			ok: false,
			error: "task dev01 is not In Progress or in Review",
		});
		expect(fakes.startTaskSession).not.toHaveBeenCalled();
	});

	it("never resumes over a live session (restarted by hand since recovery planned it)", async () => {
		const store = createWorkspaceStateStore({
			board: createBoard({ review: [createCard({ id: "dev01" })] }),
			sessions: {},
			revision: 1,
		});
		const fakes = createFakeTaskTrashWorkflowDependencies(store);
		const run = createPipelineActionRunner({
			mutateWorkspaceState: store.mutateWorkspaceState,
			ensureTaskWorktree: fakes.ensureTaskWorktree,
			startTaskSession: fakes.startTaskSession,
			hasLiveProcess: (_scope, taskId) => taskId === "dev01",
		});
		expect(await run({ ...SCOPE, kind: "resumeTask", taskId: "dev01", prompt: "x", agentId: "cline" })).toEqual({
			ok: false,
			error: "task dev01 has a live session; not resumed",
		});
		expect(fakes.startTaskSession).not.toHaveBeenCalled();
		expect(findCardInBoard(store.stored.board, "dev01")?.columnId).toBe("review");
	});

	it("updates a card's prompt and keeps its other fields", async () => {
		const dev = createCard({
			id: "d1111",
			title: "Wishlist",
			agentId: "cline",
			agentSettings: { providerId: "bedrock", modelId: "kimi" },
			autoReviewEnabled: true,
			autoReviewMode: "qa",
		});
		const { store, run } = createRunner({ review: [dev] });

		expect(
			await run({ ...SCOPE, kind: "updateTask", taskId: "d1111", prompt: "Build it\n\nREWORK round 2" }),
		).toEqual({
			ok: true,
		});
		expect(findCardInBoard(store.stored.board, "d1111")).toMatchObject({
			columnId: "review",
			card: {
				title: "Wishlist",
				prompt: "Build it\n\nREWORK round 2",
				agentId: "cline",
				agentSettings: { providerId: "bedrock", modelId: "kimi" },
				autoReviewMode: "qa",
			},
		});
		expect(await run({ ...SCOPE, kind: "updateTask", taskId: "nope1", prompt: "x" })).toEqual({
			ok: false,
			error: "task nope1 is not on the board",
		});
	});

	it("resumes with the card's own current prompt when the request names none", async () => {
		const dev = createCard({ id: "d1111", prompt: "Build it\n\nREWORK round 2", agentSettings: { modelId: "kimi" } });
		const { fakes, run } = createRunner({ review: [dev] });

		expect(await run({ ...SCOPE, kind: "resumeTask", taskId: "d1111", agentId: "cline" })).toMatchObject({
			ok: true,
		});
		expect(fakes.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining(SCOPE),
			expect.objectContaining({ prompt: "Build it\n\nREWORK round 2", agentSettings: { modelId: "kimi" } }),
		);
	});

	it("replaceLive stops a live idle session first and moves the card only once a new session started", async () => {
		const createLiveRunner = (stops: boolean) => {
			const store = createWorkspaceStateStore({
				board: createBoard({ review: [createCard({ id: "d1111" })] }),
				sessions: {},
				revision: 1,
			});
			const fakes = createFakeTaskTrashWorkflowDependencies(store);
			let live = true;
			const stopTaskSession = vi.fn(() => {
				live = !stops;
			});
			const run = createPipelineActionRunner({
				mutateWorkspaceState: store.mutateWorkspaceState,
				ensureTaskWorktree: fakes.ensureTaskWorktree,
				// The real startTaskSession returns a live idle session unchanged; refuse to "start" over one here.
				startTaskSession: async (scope, input) => {
					if (live) {
						throw new Error("started over a live session");
					}
					live = true;
					return await fakes.startTaskSession(scope, input);
				},
				hasLiveProcess: () => live,
				stopTaskSession,
				stopTimeoutMs: 300,
			});
			return { store, fakes, run, stopTaskSession };
		};

		const stopping = createLiveRunner(true);
		expect(await stopping.run({ ...SCOPE, kind: "resumeTask", taskId: "d1111", agentId: "cline" })).toEqual({
			ok: false,
			error: "task d1111 has a live session; not resumed",
		});
		expect(stopping.stopTaskSession).not.toHaveBeenCalled();
		expect(
			await stopping.run({ ...SCOPE, kind: "resumeTask", taskId: "d1111", agentId: "cline", replaceLive: true }),
		).toEqual({ ok: true, detail: "started, moved to In Progress" });
		expect(stopping.stopTaskSession).toHaveBeenCalledTimes(1);
		expect(findCardInBoard(stopping.store.stored.board, "d1111")?.columnId).toBe("in_progress");
		// The replacement is a fresh session from the (reworked) card prompt, never the old conversation.
		const replaced = vi.mocked(stopping.fakes.startTaskSession).mock.calls.at(-1)?.[1];
		expect(replaced).toMatchObject({ prompt: createCard({ id: "d1111" }).prompt.trim() });
		expect(replaced).not.toHaveProperty("resumeFromTrash");

		// A session that doesn't go away: no start, the card stays where it is.
		const stuck = createLiveRunner(false);
		expect(
			await stuck.run({ ...SCOPE, kind: "resumeTask", taskId: "d1111", agentId: "cline", replaceLive: true }),
		).toEqual({ ok: false, error: "task d1111: its live session could not be stopped; not resumed" });
		expect(findCardInBoard(stuck.store.stored.board, "d1111")?.columnId).toBe("review");
	});

	it("blocks an escalated card: Backlog with one BLOCKED: prefix", async () => {
		const { store, run } = createRunner({ review: [createCard({ id: "d1111", title: "Wishlist" })] });

		expect(await run({ ...SCOPE, kind: "blockTask", taskId: "d1111" })).toEqual({ ok: true });
		expect(await run({ ...SCOPE, kind: "blockTask", taskId: "d1111" })).toEqual({ ok: true });

		expect(findCardInBoard(store.stored.board, "d1111")).toMatchObject({
			columnId: "backlog",
			card: { title: "BLOCKED: Wishlist" },
		});
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

	it("accepts restart recovery's resumeTask on a recovery-only (landing off) workspace, never createTask/startTask", async () => {
		const runAction = vi.fn(async (): Promise<PipelineActionResult> => ({ ok: true }));
		const { host, child } = await createHost(runAction, { pipeline: { recovery: { mode: "on" } } });
		const offScope = { workspaceId: "kanban-2uge", workspacePath: "/repos/kanban-2uge" };
		const resume: PipelineActionRequest = {
			...offScope,
			kind: "resumeTask",
			taskId: "dev01",
			prompt: "x",
			agentId: "cline",
		};
		child.emit({ type: "request", id: 21, request: resume });
		child.emit({ type: "request", id: 22, request: { ...startRequest, ...offScope } });

		expect(await waitForResponse(child, 21)).toEqual({ type: "response", id: 21, ok: true, result: { ok: true } });
		expect(await waitForResponse(child, 22)).toMatchObject({
			ok: false,
			error: "workspace kanban-2uge does not run the pipeline",
		});
		expect(runAction).toHaveBeenCalledTimes(1);
		expect(runAction).toHaveBeenCalledWith(resume);
		await host.close();
	});
});
