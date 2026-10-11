// tRPC `pipeline.cardStages` (`kanban pipeline status`): the state hub's card stages of the calling workspace only.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimePipelineCardStage } from "../../../src/core/api-contract";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { createRuntimeStateHub, type RuntimeStateHub } from "../../../src/server/runtime-state-hub";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";

function stage(taskId: string, overrides: Partial<RuntimePipelineCardStage> = {}): RuntimePipelineCardStage {
	return {
		taskId,
		kind: "checks_running",
		label: "Checks running (test)",
		next: "QA next",
		qaTaskId: null,
		deadline: Date.parse("2026-10-11T07:03:00.000Z"),
		detail: null,
		inFlight: true,
		...overrides,
	};
}

const FOO_CARD: RuntimePipelineCardStage = stage("f0ba7");
const BAR_CARD: RuntimePipelineCardStage = stage("b4a12", {
	kind: "qa_running",
	label: "QA r2 running",
	qaTaskId: "12ab6",
	deadline: null,
});
const USER: RuntimeCaller = { kind: "user" };

describe("pipeline.cardStages", () => {
	const hubs: RuntimeStateHub[] = [];
	afterEach(async () => {
		for (const hub of hubs.splice(0)) {
			await hub.close();
		}
	});

	function createHub(): RuntimeStateHub {
		const hub = createRuntimeStateHub({
			workspaceRegistry: {
				resolveWorkspaceForStream: vi.fn(),
				buildProjectsPayload: vi.fn(),
				buildWorkspaceStateSnapshot: vi.fn(),
			} as unknown as Parameters<typeof createRuntimeStateHub>[0]["workspaceRegistry"],
		});
		hubs.push(hub);
		hub.setPipelineCardStages("foo", [FOO_CARD]);
		hub.setPipelineCardStages("bar", [BAR_CARD]);
		return hub;
	}

	function createCaller(context: Partial<RuntimeTrpcContext>) {
		return runtimeAppRouter.createCaller({
			requestedWorkspaceId: "foo",
			workspaceScope: { workspaceId: "foo", workspacePath: "/projects/foo" },
			getCaller: async () => USER,
			...context,
		} as unknown as RuntimeTrpcContext);
	}

	it("answers the stages the hub keeps for the calling workspace, never another project's", async () => {
		const hub = createHub();
		const caller = createCaller({ getPipelineCardStages: hub.getPipelineCardStages });
		expect(await caller.pipeline.cardStages()).toEqual({ stages: [FOO_CARD] });

		hub.setPipelineCardStages("foo", []);
		expect(await caller.pipeline.cardStages()).toEqual({ stages: [] });
		expect(hub.getPipelineCardStages("bar")).toEqual([BAR_CARD]);
	});

	it("is a workspace procedure: project isolation decides who reads it", async () => {
		const hub = createHub();
		const card: RuntimeCaller = {
			kind: "session",
			via: "credential",
			session: { workspaceId: "bar", taskId: "b4a12", role: "card", agentId: "claude", cwd: "/projects/bar" },
		};
		const checkWorkspaceAccess = vi.fn(async () => ({ outcome: "refuse", message: "bar's card can't read foo" }));
		const caller = createCaller({
			getCaller: async () => card,
			getPipelineCardStages: hub.getPipelineCardStages,
			isolationApi: { checkWorkspaceAccess } as unknown as RuntimeTrpcContext["isolationApi"],
		});
		await expect(caller.pipeline.cardStages()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(checkWorkspaceAccess).toHaveBeenCalledWith(card, "foo", "pipeline.cardStages");
	});

	it("needs a workspace scope and says so when the server has no stages to give", async () => {
		const hub = createHub();
		const unscoped = createCaller({
			requestedWorkspaceId: null,
			workspaceScope: null,
			getPipelineCardStages: hub.getPipelineCardStages,
		});
		await expect(unscoped.pipeline.cardStages()).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(createCaller({}).pipeline.cardStages()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
	});
});
