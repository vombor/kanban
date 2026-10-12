// tRPC `workspace.getTaskTokenUsage`: the board cards' token counts of the calling workspace, a workspace procedure.
import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskTokenUsageResponse } from "../../../src/core/api-contract";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";

const USER: RuntimeCaller = { kind: "user" };
const FOO_USAGE: RuntimeTaskTokenUsageResponse = {
	usage: [{ taskId: "f0ba7", input: 1_000, output: 2_000, cacheRead: 45_000, cacheWrite: 0 }],
};

function createCaller(context: Partial<RuntimeTrpcContext>) {
	return runtimeAppRouter.createCaller({
		requestedWorkspaceId: "foo",
		workspaceScope: { workspaceId: "foo", workspacePath: "/projects/foo" },
		getCaller: async () => USER,
		...context,
	} as unknown as RuntimeTrpcContext);
}

describe("workspace.getTaskTokenUsage", () => {
	it("answers the calling workspace's counts, with no price or cost", async () => {
		const loadTaskTokenUsage = vi.fn(async () => FOO_USAGE);
		const caller = createCaller({
			workspaceApi: { loadTaskTokenUsage } as unknown as RuntimeTrpcContext["workspaceApi"],
		});
		const response = await caller.workspace.getTaskTokenUsage();
		expect(response).toEqual(FOO_USAGE);
		expect(loadTaskTokenUsage).toHaveBeenCalledWith({ workspaceId: "foo", workspacePath: "/projects/foo" });
		expect(JSON.stringify(response)).not.toMatch(/cost|price|usd/iu);
	});

	it("is a workspace procedure: another project's card is refused", async () => {
		const loadTaskTokenUsage = vi.fn(async () => FOO_USAGE);
		const card: RuntimeCaller = {
			kind: "session",
			via: "credential",
			session: { workspaceId: "bar", taskId: "b4a12", role: "card", agentId: "claude", cwd: "/projects/bar" },
		};
		const checkWorkspaceAccess = vi.fn(async () => ({ outcome: "refuse", message: "bar's card can't read foo" }));
		const caller = createCaller({
			getCaller: async () => card,
			workspaceApi: { loadTaskTokenUsage } as unknown as RuntimeTrpcContext["workspaceApi"],
			isolationApi: { checkWorkspaceAccess } as unknown as RuntimeTrpcContext["isolationApi"],
		});
		await expect(caller.workspace.getTaskTokenUsage()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(loadTaskTokenUsage).not.toHaveBeenCalled();
	});
});
