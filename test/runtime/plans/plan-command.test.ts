import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approvePlan, expandPlan, type PlanApprovalClient, planMetrics, showPlan } from "../../../src/commands/plan";
import { createTask } from "../../../src/commands/task";
import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../../../src/core/api-contract";
import { createIsolationService } from "../../../src/isolation/isolation-service";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { createPlanIndexStore } from "../../../src/plans/plan-index";
import { getKanbanGlobalConfigPath, getPlanIndexPath } from "../../../src/state/kanban-home";
import type * as WorkspaceStateModule from "../../../src/state/workspace-state";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createIsolationApi } from "../../../src/trpc/isolation-api";
import { createPlansApi } from "../../../src/trpc/plans-api";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";
import {
	createBoard,
	createWorkspaceStateStore,
	type WorkspaceStateStore,
} from "../../utilities/workspace-state-store";

// The plan flow end to end against an in-memory board: `task create --role plan` applies the kit's plan routing,
// `plan approve` asks the runtime route (the real router and plans API) for the user's approval,
// and `plan expand` creates linked Backlog cards through the real createTask (so the kit's devAssignment applies).
// Never launches an agent.
const harness = vi.hoisted(() => ({ store: null as null | WorkspaceStateStore }));

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: () => ({
		projects: { add: { mutate: async () => ({ ok: true, project: { id: "ws-1" } }) } },
		workspace: { notifyStateUpdated: { mutate: async () => ({ ok: true }) } },
	}),
	httpBatchLink: () => null,
}));

vi.mock("../../../src/state/workspace-state", async (importOriginal) => {
	const original = await importOriginal<typeof WorkspaceStateModule>();
	return {
		...original,
		loadWorkspaceContext: vi.fn(async () => ({ repoPath: "/repo", workspaceId: "ws-1" })),
		mutateWorkspaceState: vi.fn((cwd: string, mutate: Parameters<WorkspaceStateStore["mutateWorkspaceState"]>[1]) => {
			if (!harness.store) {
				throw new Error("workspace state harness is not set up.");
			}
			return harness.store.mutateWorkspaceState(cwd, mutate);
		}),
	};
});

const WORKSPACE_ID = "ws-1";
const TEAM_TIER3 = { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" };

function writeConfig(kit: string): void {
	const path = getKanbanGlobalConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ workspaces: { [WORKSPACE_ID]: { kit: { name: kit } } } }));
}

function orchestrator(via: "credential" | "process" = "credential"): RuntimeCaller {
	return {
		kind: "session",
		session: {
			workspaceId: WORKSPACE_ID,
			taskId: `__home_agent__:${WORKSPACE_ID}:claude`,
			role: "orchestrator",
			agentId: "claude",
			cwd: "/repo",
		},
		via,
	};
}

function allCards(): Array<{ card: RuntimeBoardCard; column: RuntimeBoardColumnId }> {
	return (harness.store?.stored.board.columns ?? []).flatMap((column) =>
		column.cards.map((card) => ({ card, column: column.id })),
	);
}

function moveToReview(taskId: string): void {
	const board = harness.store?.stored.board;
	if (!board) {
		throw new Error("no board");
	}
	const from = board.columns.find((column) => column.cards.some((card) => card.id === taskId));
	const card = from?.cards.find((entry) => entry.id === taskId);
	if (!from || !card) {
		throw new Error(`no card ${taskId}`);
	}
	from.cards = from.cards.filter((entry) => entry.id !== taskId);
	board.columns.find((column) => column.id === "review")?.cards.push(card);
}

const BREAKDOWN = {
	version: 1,
	slug: "coupons",
	summary: "Coupons end to end.",
	cards: [
		{
			id: "schema",
			title: "Coupons table",
			prompt: "Add the coupons table and migration in src/db/schema.ts with a test.",
			parallelGroup: "w1",
			acceptanceCriteria: ["the migration test passes"],
		},
		{
			id: "api",
			title: "Redeem endpoint",
			prompt: "Add POST /api/coupons/redeem in src/api/coupons.ts with tests.",
			dependsOn: ["schema"],
			acceptanceCriteria: ["a used code returns 409", "an unknown code returns 404"],
		},
		{
			id: "ui",
			title: "Coupon field at checkout",
			prompt: "Add the coupon field to src/app/checkout/page.tsx, calling the redeem endpoint.",
			dependsOn: ["api"],
			acceptanceCriteria: ["the total drops after a valid code"],
		},
	],
};

describe("kanban plan", () => {
	let stderr: ReturnType<typeof vi.spyOn>;
	let worktree: ReturnType<typeof createTempDir>;

	beforeEach(() => {
		runtime.caller = { kind: "user" };
		router = createRouterCaller();
		harness.store = createWorkspaceStateStore({ board: createBoard({}), sessions: {}, revision: 1 });
		stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		worktree = createTempDir("kanban-plan-worktree-");
	});

	afterEach(() => {
		stderr.mockRestore();
		worktree.cleanup();
		harness.store = null;
	});

	const writeBreakdown = (content: unknown = BREAKDOWN) => {
		mkdirSync(join(worktree.path, "docs/specs"), { recursive: true });
		writeFileSync(join(worktree.path, "docs/specs/coupons.md"), "# Coupons\n\n## Problem\n…\n");
		writeFileSync(
			join(worktree.path, "docs/specs/coupons.cards.json"),
			typeof content === "string" ? content : JSON.stringify(content, null, 2),
		);
	};

	// The running server: who calls (strict lookup, isolation off).
	const runtime = { caller: { kind: "user" } as RuntimeCaller };
	const createRouterCaller = () => {
		const service = createIsolationService({
			readConfig: async () => parsePipelineConfig({}).config,
			processReader: null,
			listLiveSessions: () => [],
			log: async () => {},
		});
		const notices = { allowSend: () => true, enqueue: () => {} };
		const context = {
			requestedWorkspaceId: WORKSPACE_ID,
			workspaceScope: { workspaceId: WORKSPACE_ID, workspacePath: "/repo" },
			getCaller: async () => runtime.caller,
			resolveStrictCaller: async () => runtime.caller,
			isolationApi: createIsolationApi({ service, listEntries: async () => [], notices }),
			plansApi: createPlansApi({
				log: service.log,
				findWorktree: async () => worktree.path,
			}),
		} as unknown as RuntimeTrpcContext;
		return runtimeAppRouter.createCaller(context);
	};
	let router: ReturnType<typeof createRouterCaller>;
	const client = (): PlanApprovalClient =>
		({
			plans: {
				approve: { mutate: (input: never) => router.plans.approve(input) },
				preview: { query: (input: never) => router.plans.preview(input) },
			},
		}) as unknown as PlanApprovalClient;
	const deps = () => ({
		findWorktree: async () => worktree.path,
		measure: async () => ({
			measuredAt: "2026-10-07T12:00:00.000Z",
			agent: "claude",
			provider: null,
			model: "claude-opus-5-5",
			wallMin: 12.5,
			activeMin: 9,
			costUSD: null,
		}),
		createClient: () => client(),
	});

	const createPlanCard = async () => {
		const result = await createTask({
			cwd: "/repo",
			title: "Coupons",
			prompt: "Customers can redeem coupons at checkout.",
			role: "plan",
		});
		const id = (result.task as { id: string }).id;
		return { result, id };
	};

	it("team kit: a plan card gets Claude in plan mode, the plan prompt and an index entry", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig("team");
			const { result, id } = await createPlanCard();
			const [entry] = allCards();
			expect(entry?.column).toBe("backlog");
			expect(entry?.card).toMatchObject({
				id,
				role: "plan",
				agentId: "claude",
				startInPlanMode: true,
				title: "Coupons",
			});
			expect(entry?.card.agentSettings).toBeUndefined();
			expect(entry?.card.prompt).toContain("You are the planning agent");
			expect(entry?.card.prompt).toContain("Customers can redeem coupons at checkout.");
			expect(result).toMatchObject({ plan: { kit: "team", slug: "coupons", spec: "docs/specs/coupons.md" } });
			expect((await createPlanIndexStore().read(WORKSPACE_ID)).plans[id]).toMatchObject({
				slug: "coupons",
				kit: "team",
				agentId: "claude",
				modelId: null,
				startInPlanMode: true,
				approval: null,
			});
			// A second plan with the same title gets its own spec file.
			const second = await createPlanCard();
			expect(second.result).toMatchObject({ plan: { slug: "coupons-2" } });
		});
	});

	it("default kit: no plan cards (the one agent plans its own work)", async () => {
		await withTemporaryKanbanHome(async () => {
			await expect(createPlanCard()).rejects.toThrow(/plan\.enabled off/u);
			expect(allCards()).toEqual([]);
			expect(existsSync(getPlanIndexPath(WORKSPACE_ID))).toBe(false);
		});
	});

	it("expand: refuses without approval, --dry-run writes nothing, then creates linked Backlog cards with devAssignment", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig("team");
			const { id } = await createPlanCard();
			writeBreakdown();

			// Not in Review yet (the planner is still working).
			await expect(approvePlan({ cwd: "/repo", taskId: id }, deps())).rejects.toThrow(
				/approve it once its planner/u,
			);
			moveToReview(id);

			await expect(expandPlan({ cwd: "/repo", taskId: id }, deps())).rejects.toThrow(/is not approved/u);
			const indexBefore = readFileSync(getPlanIndexPath(WORKSPACE_ID), "utf8");
			const revisionBefore = harness.store?.stored.revision;

			const dryRun = await expandPlan({ cwd: "/repo", taskId: id, dryRun: true }, deps());
			expect(dryRun).toMatchObject({ ok: true, dryRun: true, approved: false });
			expect((dryRun.cards as unknown[]).length).toBe(3);
			expect(dryRun.links).toHaveLength(2);
			expect(allCards()).toHaveLength(1);
			expect(harness.store?.stored.revision).toBe(revisionBefore);
			expect(readFileSync(getPlanIndexPath(WORKSPACE_ID), "utf8")).toBe(indexBefore);

			const shown = await showPlan({ cwd: "/repo", taskId: id }, deps());
			expect(shown.text).toContain("Approval: not approved");
			expect(shown.text).toContain("- api: Redeem endpoint (after schema)");
			expect(shown.text).toContain("# Coupons");

			const approved = await approvePlan({ cwd: "/repo", taskId: id }, deps());
			expect(approved).toMatchObject({ ok: true, cards: 3, approval: { via: "approve" } });
			const expanded = await expandPlan({ cwd: "/repo", taskId: id }, deps());
			expect(expanded).toMatchObject({ ok: true, linksAdded: 2, linksSkipped: 0 });

			const mapping = (await createPlanIndexStore().read(WORKSPACE_ID)).plans[id];
			expect(mapping?.expansion).toMatchObject({
				status: "done",
				links: [
					{ waiting: "api", prerequisite: "schema" },
					{ waiting: "ui", prerequisite: "api" },
				],
			});
			expect(mapping?.metrics).toMatchObject({ agent: "claude", wallMin: 12.5 });
			const taskIds = mapping?.expansion?.cards ?? {};
			const dev = allCards().filter(({ card }) => card.id !== id);
			expect(dev.map(({ card, column }) => [card.id, column, card.role, card.agentId])).toEqual([
				[taskIds.schema, "backlog", undefined, "cline"],
				[taskIds.api, "backlog", undefined, "cline"],
				[taskIds.ui, "backlog", undefined, "cline"],
			]);
			for (const { card } of dev) {
				// The kit's devAssignment, as for any new dev card.
				expect(card.agentSettings).toEqual(TEAM_TIER3);
				expect(card.prompt).toContain(`Acceptance criteria (from plan card ${id}`);
			}
			expect(dev[1]?.card.prompt).toContain("- a used code returns 409\n- an unknown code returns 404");
			expect(harness.store?.stored.board.dependencies.map((link) => [link.fromTaskId, link.toTaskId])).toEqual([
				[taskIds.api, taskIds.schema],
				[taskIds.ui, taskIds.api],
			]);
			// Nothing linked to the plan card, and nothing started.
			expect(harness.store?.stored.sessions).toEqual({});

			await expect(expandPlan({ cwd: "/repo", taskId: id }, deps())).rejects.toThrow(/already expanded/u);
			const metrics = await planMetrics({ cwd: "/repo" });
			expect(metrics.plans).toEqual([
				expect.objectContaining({ planTaskId: id, approved: true, cards: 3, reworks: 0, agent: "claude" }),
			]);
		});
	});

	it("refuses a bad breakdown, and a breakdown changed after the approval", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig("team");
			const { id } = await createPlanCard();
			moveToReview(id);
			writeBreakdown({ ...BREAKDOWN, cards: [{ ...BREAKDOWN.cards[1], dependsOn: ["missing"] }] });
			await expect(approvePlan({ cwd: "/repo", taskId: id }, deps())).rejects.toThrow(
				/is not a card of this breakdown/u,
			);
			await expect(expandPlan({ cwd: "/repo", taskId: id, approvedByUser: true }, deps())).rejects.toThrow(
				/invalid/u,
			);

			writeBreakdown();
			await approvePlan({ cwd: "/repo", taskId: id }, deps());
			writeBreakdown({ ...BREAKDOWN, summary: "Changed after the review." });
			await expect(expandPlan({ cwd: "/repo", taskId: id }, deps())).rejects.toThrow(
				/changed after the user approved/u,
			);
			expect(allCards()).toHaveLength(1);
		});
	});

	it("--approved-by-user from the user's shell approves this breakdown and expands at once", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig("team");
			const { id } = await createPlanCard();
			moveToReview(id);
			writeBreakdown();

			const expanded = await expandPlan({ cwd: "/repo", taskId: id, approvedByUser: true }, deps());
			expect(expanded).toMatchObject({ ok: true, approval: { via: "expand" } });
			expect(allCards()).toHaveLength(4);
		});
	});

	it("resumes a half-done expand with the same task ids", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig("team");
			const { id } = await createPlanCard();
			moveToReview(id);
			writeBreakdown();
			await approvePlan({ cwd: "/repo", taskId: id }, deps());
			let calls = 0;
			const failingCreate: typeof createTask = async (input) => {
				calls += 1;
				if (calls === 2) {
					throw new Error("board save refused");
				}
				return await createTask(input);
			};
			await expect(
				expandPlan({ cwd: "/repo", taskId: id }, { ...deps(), createCard: failingCreate }),
			).rejects.toThrow(/board save refused/u);
			const chosen = (await createPlanIndexStore().read(WORKSPACE_ID)).plans[id]?.expansion;
			expect(chosen?.status).toBe("creating");
			expect(allCards()).toHaveLength(2);

			await expandPlan({ cwd: "/repo", taskId: id }, deps());
			expect(
				allCards()
					.map(({ card }) => card.id)
					.filter((taskId) => taskId !== id),
			).toEqual(Object.values(chosen?.cards ?? {}));
		});
	});

	describe("the user-only approval route", () => {
		const setUpPlan = async () => {
			writeConfig("team");
			const { id } = await createPlanCard();
			moveToReview(id);
			writeBreakdown();
			return id;
		};
		const approvalOf = async (id: string) => (await createPlanIndexStore().read(WORKSPACE_ID)).plans[id]?.approval;
		const refusal = (id: string) =>
			`Plan approval is the user's; ask them to run kanban plan approve ${id} or use the board`;

		it("refuses every agent session, isolation off: credentialed, traced to its process tree, or unidentified", async () => {
			await withTemporaryKanbanHome(async () => {
				const id = await setUpPlan();
				const card: RuntimeCaller = {
					kind: "session",
					session: { workspaceId: "other", taskId: "c1", role: "card", agentId: "codex", cwd: "/w/c1" },
					via: "credential",
				};
				const callers: RuntimeCaller[] = [
					orchestrator(),
					card,
					// A process that dropped its credential but still runs under its session's PTY.
					orchestrator("process"),
					// A credential used outside its session's process tree.
					{ kind: "unknown", reason: "credential used outside its session's process tree" },
				];
				for (const caller of callers) {
					runtime.caller = caller;
					const answer = await router.plans.approve({ taskId: id });
					expect(answer).toMatchObject({ ok: false, approval: null });
					expect(answer.error).toContain(refusal(id));
					await expect(approvePlan({ cwd: "/repo", taskId: id }, deps())).rejects.toThrow(refusal(id));
					await expect(expandPlan({ cwd: "/repo", taskId: id, approvedByUser: true }, deps())).rejects.toThrow(
						refusal(id),
					);
				}
				// Nothing approved, no card created.
				expect(await approvalOf(id)).toBeNull();
				expect(allCards()).toHaveLength(1);
			});
		});

		it("the user approves at once, with no console code; a reparented process looks the same (the trade-off)", async () => {
			await withTemporaryKanbanHome(async () => {
				const id = await setUpPlan();
				// The strict lookup finds no session above the caller: the user's shell or browser, or a process that
				// left its session's tree. Both are taken for the user (user request, 2026-10-09).
				runtime.caller = { kind: "user" };
				const answer = await router.plans.approve({ taskId: id });
				expect(answer).toMatchObject({
					ok: true,
					approval: { via: "approve" },
					plan: { cards: 3, specTitle: "Coupons", approval: { state: "approved" } },
				});
				expect(answer).not.toHaveProperty("approvalId");
				expect(await approvalOf(id)).toEqual(answer.approval);
				expect(answer.approval?.breakdownSha256).toBe(answer.plan?.breakdownSha256);
			});
		});

		it("kanban plan approve from the user's shell: pinned to the breakdown, a new breakdown needs a new approval", async () => {
			await withTemporaryKanbanHome(async () => {
				const id = await setUpPlan();
				const first = await approvePlan({ cwd: "/repo", taskId: id }, deps());
				expect(first).toMatchObject({ ok: true, cards: 3, approval: { via: "approve" } });
				expect(await approvalOf(id)).toEqual(first.approval);

				writeBreakdown({ ...BREAKDOWN, summary: "Second round." });
				expect((await router.plans.preview({ taskId: id })).plan?.approval?.state).toBe("stale");
				const second = await approvePlan({ cwd: "/repo", taskId: id }, deps());
				expect((second.approval as { breakdownSha256: string }).breakdownSha256).not.toBe(
					(first.approval as { breakdownSha256: string }).breakdownSha256,
				);
			});
		});

		it("the browser approves only the breakdown it showed", async () => {
			await withTemporaryKanbanHome(async () => {
				const id = await setUpPlan();
				const preview = await router.plans.preview({ taskId: id });
				expect(preview).toMatchObject({
					ok: true,
					plan: { taskId: id, specTitle: "Coupons", cards: 3, approval: null },
				});
				const shownSha = preview.plan?.breakdownSha256 ?? null;

				writeBreakdown({ ...BREAKDOWN, summary: "Changed after the review." });
				expect(await router.plans.approve({ taskId: id, breakdownSha256: shownSha })).toMatchObject({
					ok: false,
					approval: null,
					error: expect.stringContaining("changed since it was shown"),
				});
				expect(await approvalOf(id)).toBeNull();

				const shownAgain = (await router.plans.preview({ taskId: id })).plan?.breakdownSha256 ?? null;
				const approved = await router.plans.approve({ taskId: id, breakdownSha256: shownAgain });
				expect(approved).toMatchObject({ ok: true, approval: { via: "approve", breakdownSha256: shownAgain } });
			});
		});

		it("the orchestrator expands an approved plan; an edited breakdown needs the user again", async () => {
			await withTemporaryKanbanHome(async () => {
				const id = await setUpPlan();
				await approvePlan({ cwd: "/repo", taskId: id }, deps());

				writeBreakdown({ ...BREAKDOWN, summary: "Edited after the approval." });
				runtime.caller = orchestrator();
				await expect(expandPlan({ cwd: "/repo", taskId: id }, deps())).rejects.toThrow(
					/changed after the user approved/u,
				);
				await expect(approvePlan({ cwd: "/repo", taskId: id }, deps())).rejects.toThrow(refusal(id));

				runtime.caller = { kind: "user" };
				await approvePlan({ cwd: "/repo", taskId: id }, deps());
				runtime.caller = orchestrator();
				const expanded = await expandPlan({ cwd: "/repo", taskId: id }, deps());
				expect(expanded).toMatchObject({ ok: true, linksAdded: 2 });
				expect(allCards()).toHaveLength(4);
			});
		});
	});
});
