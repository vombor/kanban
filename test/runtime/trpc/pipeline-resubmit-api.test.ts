// `kanban task resubmit` (issue #20): who may ask, which cards qualify, and what a request records.
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { AgentSessionIdentity, RuntimeCaller } from "../../../src/isolation/session-identity";
import { loadKitCatalog } from "../../../src/kits/resolve-kit";
import type { PipelineDecisionRecord } from "../../../src/pipeline/decision-log";
import { createPipelineStateStore } from "../../../src/pipeline/pipeline-state";
import { readResubmitRequest } from "../../../src/pipeline/resubmit";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createPipelineResubmitApi, decideResubmitCaller } from "../../../src/trpc/pipeline-resubmit-api";
import { createTempDir } from "../../utilities/temp-dir";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

function session(workspaceId: string, role: AgentSessionIdentity["role"], taskId: string): RuntimeCaller {
	return {
		kind: "session",
		via: "credential",
		session: { workspaceId, taskId, role, agentId: "claude", cwd: `/projects/${workspaceId}` },
	};
}

const USER: RuntimeCaller = { kind: "user" };
const OWN_ORCHESTRATOR = session("foo", "orchestrator", "__home_agent__:foo:claude");
const OTHER_ORCHESTRATOR = session("bar", "orchestrator", "__home_agent__:bar:claude");
const OWN_CARD = session("foo", "card", "d1111");
const UNKNOWN: RuntimeCaller = { kind: "unknown", reason: "a credential outside its session's process tree" };
const NOW = Date.parse("2026-10-09T09:00:00.000Z");
const QA_WORKSPACE = { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } };

describe("resubmit caller rules", () => {
	it("allows the user and the project's own orchestrator, refuses everyone else", () => {
		expect(decideResubmitCaller(USER, "foo")).toEqual({ allowed: true, by: "user" });
		expect(decideResubmitCaller(OWN_ORCHESTRATOR, "foo")).toEqual({
			allowed: true,
			by: "orchestrator __home_agent__:foo:claude",
		});
		const refused = (caller: RuntimeCaller) => {
			const decision = decideResubmitCaller(caller, "foo");
			return decision.allowed ? "allowed" : decision.message;
		};
		expect(refused(OTHER_ORCHESTRATOR)).toContain("not the orchestrator of bar");
		expect(refused(OWN_CARD)).toContain("card d1111 of foo can't");
		expect(refused(UNKNOWN)).toContain("an unidentified agent session");
	});
});

describe("resubmit api", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	function setup(
		options: {
			config?: unknown;
			review?: RuntimeBoardCard[];
			backlog?: RuntimeBoardCard[];
			session?: Partial<RuntimeTaskSessionSummary>;
		} = {},
	) {
		const temp = createTempDir("kanban-resubmit-");
		cleanups.push(temp.cleanup);
		const store = createPipelineStateStore({
			now: () => NOW,
			getStatePath: (workspaceId) => join(temp.path, "data", workspaceId, "pipeline-state.json"),
			getLegacyChecksStatePaths: () => [],
		});
		const decisions: PipelineDecisionRecord[] = [];
		const refusals: Array<{ action: string; kind: string }> = [];
		const requestSnapshot = vi.fn();
		const board = createBoard({
			review: options.review ?? [createCard({ id: "f0ba7" })],
			backlog: options.backlog ?? [],
		});
		const api = createPipelineResubmitApi({
			log: async (_workspaceIds, record) => {
				refusals.push({ action: record.action, kind: record.kind });
			},
			loadWorkspaceState: async () => ({
				repoPath: "/projects/foo",
				statePath: "/tmp/state",
				git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
				board,
				sessions: Object.fromEntries(
					options.session
						? [
								[
									"f0ba7",
									{
										taskId: "f0ba7",
										state: "awaiting_review",
										...options.session,
									} as RuntimeTaskSessionSummary,
								],
							]
						: [],
				),
				revision: 1,
			}),
			requestSnapshot,
			readConfig: async () => parsePipelineConfig(options.config ?? { workspaces: { foo: QA_WORKSPACE } }),
			loadCatalog: async () => await loadKitCatalog(join(temp.path, "kits")),
			store,
			decisionLog: {
				append: async (records) => {
					decisions.push(...records);
				},
			},
			now: () => NOW,
		});
		const resubmit = (caller: RuntimeCaller, taskId = "f0ba7") =>
			api.resubmit({ caller, workspaceId: "foo", request: { taskId } });
		return { api, store, decisions, refusals, requestSnapshot, resubmit };
	}

	it("records the request, logs it in the decision log and asks for a snapshot", async () => {
		const { store, decisions, requestSnapshot, resubmit } = setup();
		const response = await resubmit(OWN_ORCHESTRATOR);
		expect(response).toMatchObject({ ok: true, taskId: "f0ba7", requestedAt: new Date(NOW).toISOString() });
		expect(readResubmitRequest((await store.load("foo")).cards.f0ba7)).toEqual({
			at: new Date(NOW).toISOString(),
			by: "orchestrator __home_agent__:foo:claude",
		});
		expect(decisions).toEqual([
			expect.objectContaining({
				workspaceId: "foo",
				taskId: "f0ba7",
				stage: "resubmit",
				kit: "team",
				landingMode: "qa",
				role: "dev",
				outcome: "acted",
				answer: { by: "orchestrator __home_agent__:foo:claude" },
			}),
		]);
		expect(requestSnapshot).toHaveBeenCalledWith("foo");
	});

	it("refuses cards, other orchestrators and unknown callers, logs them and records nothing", async () => {
		const { store, decisions, refusals, requestSnapshot, resubmit } = setup();
		for (const caller of [OWN_CARD, OTHER_ORCHESTRATOR, UNKNOWN]) {
			const response = await resubmit(caller);
			expect(response.ok).toBe(false);
		}
		expect(refusals).toEqual([
			{ action: "pipeline.resubmit", kind: "refused" },
			{ action: "pipeline.resubmit", kind: "refused" },
			{ action: "pipeline.resubmit", kind: "refused" },
		]);
		expect(await store.peek("foo")).toBeNull();
		expect(decisions).toEqual([]);
		expect(requestSnapshot).not.toHaveBeenCalled();
	});

	it("on another landing mode there is nothing to submit to", async () => {
		const { resubmit, requestSnapshot } = setup({ config: { workspaces: { foo: { landing: { mode: "off" } } } } });
		const response = await resubmit(USER);
		expect(response.ok).toBe(false);
		expect(response.error).toContain("landing mode off: the pipeline submits no cards there");
		expect(requestSnapshot).not.toHaveBeenCalled();
	});

	it("only a Review dev card whose session isn't running, and not an escalated one", async () => {
		const notInReview = setup({ review: [], backlog: [createCard({ id: "f0ba7" })] });
		expect((await notInReview.resubmit(USER)).error).toContain("is in backlog, not Review");
		expect((await notInReview.resubmit(USER, "gone1")).error).toContain("is not on foo's board");

		const qaCard = setup({ review: [createCard({ id: "f0ba7", role: "qa" })] });
		expect((await qaCard.resubmit(USER)).error).toContain("is a qa card");

		const running = setup({ session: { state: "running" } });
		expect((await running.resubmit(USER)).error).toContain("is still running");

		const escalated = setup();
		await escalated.store.update("foo", (state) => ({
			...state,
			cards: { f0ba7: { qaflow: { escalated: { at: "2026-10-09T08:00:00.000Z" } } } },
		}));
		expect((await escalated.resubmit(USER)).error).toContain("kanban task handback");
		expect(escalated.decisions).toEqual([]);
	});

	it("the route decides on the strict caller (the process-tree lookup), not the lazy one", async () => {
		const resubmit = vi.fn(async () => ({ ok: true, taskId: "f0ba7", requestedAt: null }));
		const caller = runtimeAppRouter.createCaller({
			requestedWorkspaceId: "foo",
			workspaceScope: { workspaceId: "foo", workspacePath: "/projects/foo" },
			getCaller: async (): Promise<RuntimeCaller> => USER,
			resolveStrictCaller: async () => OWN_CARD,
			pipelineResubmitApi: { resubmit },
		} as unknown as RuntimeTrpcContext);
		await caller.pipeline.resubmit({ taskId: "f0ba7" });
		expect(resubmit.mock.calls).toEqual([[{ caller: OWN_CARD, workspaceId: "foo", request: { taskId: "f0ba7" } }]]);
	});
});
