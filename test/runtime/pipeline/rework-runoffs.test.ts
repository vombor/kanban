// The rework loop's sibling cards and the hold, against the walks that let two cards land (P4-T3 review):
// a board link restarting a BLOCKED original, a runoff card handing its task to a sibling outside the group, the
// core cap swallowing the kit's tier escalation, and a runoff sibling that never started.
import { afterEach, describe, expect, it } from "vitest";

import { moveTaskToColumn, trashTaskAndGetReadyLinkedTaskIds } from "../../../src/core/task-board-mutations";
import { createRoutingPolicy, type OnFailAnswer } from "../../../src/kits/policy";
import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";
import type { PipelineActionRequest } from "../../../src/pipeline/actions";
import type {
	PipelineRunoffGroup,
	PipelineRunoffGroupHandler,
	PipelineRunoffGroups,
} from "../../../src/pipeline/features";
import { releaseHold } from "../../../src/pipeline/hold";
import { readEscalationRecord, readQaflow } from "../../../src/pipeline/rework";
import { createPipelineActionRunner } from "../../../src/server/pipeline-actions";
import { createReworkHarness, failVerdict, type ReworkHarnessOptions } from "../../utilities/rework-stage";
import {
	createBoard,
	createCard,
	createFakeTaskTrashWorkflowDependencies,
	createWorkspaceStateStore,
	findCardInBoard,
} from "../../utilities/workspace-state-store";

const DEV = createCard({
	id: "d1111",
	title: "Wishlist",
	prompt: "Build the wishlist.\n\nFINAL STEP: print STATUS: DONE",
	agentId: "cline",
	agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
});
const SESSION = { taskId: "d1111", agentId: "cline" as const, modelId: "us.openai.gpt-6.1-sol" };
const TIER2 = { agentId: "cline" as const, model: { provider: "bedrock", model: "us.moonshotai.kimi-k3" } };

function kinds(actions: ReturnType<typeof createReworkHarness>["actions"]) {
	return actions.map(
		(action) => `${action.kind}:${"taskId" in action ? action.taskId : "task" in action ? action.task.taskId : ""}`,
	);
}

function teamPolicy(overrides: Record<string, unknown>) {
	const team = getBuiltInKits().get("team");
	if (!team) {
		throw new Error("team kit missing");
	}
	const resolved = resolveKitLayers(getDefaultKit(), team, overrides);
	if (!resolved.ok) {
		throw new Error(resolved.error);
	}
	return createRoutingPolicy(resolved.kit);
}

function createGroups(racing: string | null = null) {
	const recorded: PipelineRunoffGroup[] = [];
	const handler: PipelineRunoffGroupHandler = {
		groupOf: async () => racing,
		record: async (group) => {
			recorded.push(structuredClone(group));
		},
	};
	return { recorded, groups: { forWorkspace: () => handler } satisfies PipelineRunoffGroups };
}

describe("rework siblings never let two cards land", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	const createHarness = (options?: ReworkHarnessOptions) => {
		const harness = createReworkHarness(options);
		harnesses.push(harness);
		return harness;
	};
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	it("escalation sibling: create → block → start the sibling → sibling Done never restarts the BLOCKED original", async () => {
		const harness = createHarness({
			onFail: () => ({ action: "escalate", to: TIER2, requireApproval: true, reason: "tier 2" }),
		});
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(harness.actions)).toEqual(["createTask:s0001", "blockTask:d1111"]);

		// Carry the stage's requests out on a real board, then a human starts the sibling and it lands.
		const store = createWorkspaceStateStore({ board: createBoard({ review: [DEV] }), sessions: {}, revision: 1 });
		const fakes = createFakeTaskTrashWorkflowDependencies(store);
		const run = createPipelineActionRunner({
			mutateWorkspaceState: store.mutateWorkspaceState,
			ensureTaskWorktree: fakes.ensureTaskWorktree,
			startTaskSession: fakes.startTaskSession,
		});
		const scope = { workspaceId: "foo", workspacePath: "/repos/foo" };
		for (const action of harness.actions) {
			expect(await run({ ...scope, ...(action as PipelineActionRequest) })).toMatchObject({ ok: true });
		}
		expect(findCardInBoard(store.stored.board, "d1111")?.columnId).toBe("backlog");
		expect(await run({ ...scope, kind: "startTask", taskId: "s0001" })).toMatchObject({ ok: true });
		expect(store.stored.board.dependencies).toEqual([]);
		// The sibling submits and lands: its Done must start nothing (the BLOCKED original least of all).
		const reviewed = moveTaskToColumn(store.stored.board, "s0001", "review").board;
		expect(trashTaskAndGetReadyLinkedTaskIds(reviewed, "s0001").readyTaskIds).toEqual([]);
	});

	it("inside an open runoff an escalation to a model goes to the orchestrator, with no sibling outside the group", async () => {
		const { groups } = createGroups("d0000-r1");
		const harness = createHarness({
			onFail: () => ({ action: "escalate", to: TIER2, requireApproval: false, reason: "tier 2" }),
			runoffGroups: groups,
		});
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);

		expect(kinds(harness.actions)).toEqual(["blockTask:d1111"]);
		expect(harness.preservedTags).toEqual([]);
		expect(readEscalationRecord(readQaflow(await harness.entry("d1111")))).toMatchObject({
			to: "orchestrator",
			reason: expect.stringContaining("it races in runoff d0000-r1, so it goes to the orchestrator"),
		});
	});

	it("the team kit with escalate.to { tier: tier2 } escalates to a tier-2 sibling after three FAILs (the core cap asks the kit)", async () => {
		const policy = teamPolicy({ "escalate.to": { tier: "tier2" } });
		const harness = createHarness({ onFail: (input) => policy.onFail(input) });
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1), failVerdict(2), failVerdict(3)] });
		await harness.tick({ review: [DEV] }, [SESSION]);

		// team: requireApproval, so the tier-2 sibling waits in Backlog for the orchestrator or the user.
		expect(kinds(harness.actions)).toEqual(["createTask:s0001", "blockTask:d1111"]);
		expect(harness.actions[0]).toMatchObject({
			kind: "createTask",
			task: { agentId: "cline", agentSettings: { providerId: "bedrock", modelId: "us.moonshotai.kimi-k3" } },
		});
		expect(readEscalationRecord(readQaflow(await harness.entry("d1111")))).toMatchObject({
			reason: "3 FAIL rounds (rounds 1, 2, 3)",
			to: TIER2,
			requireApproval: true,
			sibling: { taskId: "s0001", started: false },
		});

		// Without the opt-in the same three FAILs go to the orchestrator.
		const plain = teamPolicy({});
		const orchestrator = createHarness({ onFail: (input) => plain.onFail(input) });
		await orchestrator.seed("d1111", { qaVerdicts: [failVerdict(1), failVerdict(2), failVerdict(3)] });
		await orchestrator.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(orchestrator.actions)).toEqual(["blockTask:d1111"]);
	});

	it("a runoff winner whose land conflicts goes down the rework conflict path (legacy: back to the PASS path)", async () => {
		const harness = createHarness();
		const pass = failVerdict(1, { verdict: "PASS", blocking: [] });
		await harness.seed("d1111", {
			qaVerdicts: [pass],
			qaPass: {
				qaTaskId: pass.qaTaskId,
				snapshot: pass.snapshot,
				at: pass.at,
				action: "hold",
				status: null,
				error: null,
			},
			hold: { group: "d0000-r1", at: new Date(pass.at).toISOString(), round: 1 },
		});
		const released = await releaseHold(
			{
				store: harness.store,
				finishTask: async () => ({
					ok: false,
					status: "blocked",
					taskId: "d1111",
					previousColumnId: "review",
					readyTaskIds: [],
					autoStartedTasks: [],
					worktreeDeleted: false,
					error: "conflicts in src/cart.ts",
					landing: { decision: "conflict", baseRef: "main", files: ["src/cart.ts"] },
				}),
				preserveWork: async () => {},
				now: () => pass.at + 60_000,
			},
			{ workspaceId: "foo", workspacePath: "/repos/foo", taskId: "d1111", decision: "land" },
		);
		expect(released).toMatchObject({ ok: false, code: "conflict" });

		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(harness.actions)).toEqual(["updateTask:d1111", "deliverInput:d1111"]);
		const update = harness.actions[0];
		expect(update?.kind === "updateTask" ? update.prompt : "").toContain(
			"rebase onto main: conflicts in src/cart.ts",
		);
	});

	const runoffAnswer = (): OnFailAnswer => ({
		action: "runoff",
		models: [
			{ agentId: "cline", provider: "bedrock", model: "us.moonshotai.kimi-k3" },
			{ agentId: "codex", provider: null, model: "gpt-6.1" },
		],
	});

	it("a runoff sibling that can't start is discarded and dropped from the group", async () => {
		const { recorded, groups } = createGroups();
		const harness = createHarness({
			onFail: runoffAnswer,
			runoffGroups: groups,
			actionResult: (action) =>
				action.kind === "startTask" && action.taskId === "s0002"
					? { ok: false, error: "no worktree" }
					: { ok: true },
		});
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);

		expect(kinds(harness.actions)).toEqual([
			"createTask:s0001",
			"startTask:s0001",
			"createTask:s0002",
			"startTask:s0002",
			"finishTask:s0002",
			"updateTask:d1111",
			"deliverInput:d1111",
		]);
		expect(harness.actions[4]).toMatchObject({ kind: "finishTask", landing: "discard", trigger: "pipeline" });
		expect(recorded.at(-1)?.cards.map((card) => card.taskId)).toEqual(["d1111", "s0001"]);
		expect(harness.readQaLog()).toContain("card s0002 could not start and was discarded");
	});

	it("a runoff sibling that can neither start nor be discarded stays in the group, parked as escalated BLOCKED", async () => {
		const { recorded, groups } = createGroups();
		const harness = createHarness({
			onFail: runoffAnswer,
			runoffGroups: groups,
			actionResult: (action) =>
				(action.kind === "startTask" || action.kind === "finishTask") && action.taskId === "s0002"
					? { ok: false, error: "server busy" }
					: { ok: true },
		});
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);

		expect(kinds(harness.actions)).toContain("blockTask:s0002");
		expect(recorded).toHaveLength(1);
		expect(readEscalationRecord(readQaflow(await harness.entry("s0002")))).toMatchObject({
			cause: "never_started",
			to: "orchestrator",
		});
	});
});
