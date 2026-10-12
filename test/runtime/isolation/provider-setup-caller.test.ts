// Who may run `kanban setup-provider` (KANBAN_ORCHESTRATOR_OR_USER_COMMANDS in src/isolation/cli-scope.ts): the user
// and the Kanban project's orchestrator, decided by the server's route with the strict caller
// (src/trpc/provider-setup-api.ts).
import { describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { decideKanbanOrchestratorCaller } from "../../../src/isolation/cli-scope";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { createProviderSetupApi } from "../../../src/trpc/provider-setup-api";

const KANBAN = "kanban-2uge";

function session(workspaceId: string, role: "orchestrator" | "card", via: "credential" | "process" = "credential") {
	return {
		kind: "session",
		session: {
			workspaceId,
			taskId: role === "orchestrator" ? `__home_agent__:${workspaceId}:claude` : "t1",
			role,
			agentId: "claude",
			cwd: `/projects/${workspaceId}`,
		},
		via,
	} satisfies RuntimeCaller;
}

describe("decideKanbanOrchestratorCaller", () => {
	it("allows the user and the Kanban project's orchestrator, refuses everyone else with who may run it", () => {
		expect(decideKanbanOrchestratorCaller({ kind: "user" }, KANBAN)).toEqual({ allowed: true });
		expect(decideKanbanOrchestratorCaller(session(KANBAN, "orchestrator"), KANBAN)).toEqual({ allowed: true });
		// Its headless wake or a credential-less call traced to its process tree is the same orchestrator.
		expect(decideKanbanOrchestratorCaller(session(KANBAN, "orchestrator", "process"), KANBAN)).toEqual({
			allowed: true,
		});
		const refused: RuntimeCaller[] = [
			session("foo", "orchestrator"),
			session(KANBAN, "card"),
			session("foo", "card", "process"),
			{ kind: "unknown", reason: "no session above the caller" },
		];
		for (const caller of refused) {
			const decision = decideKanbanOrchestratorCaller(caller, KANBAN);
			expect(decision.allowed).toBe(false);
			expect(decision.allowed ? null : decision.message).toContain(
				"only the user or the Kanban project's orchestrator (workspace kanban-2uge) runs it",
			);
		}
		const other = decideKanbanOrchestratorCaller(session("foo", "orchestrator"), KANBAN);
		expect(other.allowed ? null : other.message).toContain("the orchestrator of foo can't");
	});

	it("follows the configured workspace", () => {
		expect(parsePipelineConfig({}).config.providers.setupWorkspaceId).toBe(KANBAN);
		expect(parsePipelineConfig({ providers: { setupWorkspaceId: "k2" } }).config.providers.setupWorkspaceId).toBe(
			"k2",
		);
		expect(decideKanbanOrchestratorCaller(session(KANBAN, "orchestrator"), "k2").allowed).toBe(false);
		expect(decideKanbanOrchestratorCaller(session("k2", "orchestrator"), "k2").allowed).toBe(true);
	});
});

describe("providers.authorizeSetup", () => {
	it("answers from the configured workspace and logs a refusal on both sides", async () => {
		const log = vi.fn(async () => {});
		const api = createProviderSetupApi({ log, readSetupWorkspaceId: async () => KANBAN });
		expect(await api.authorize({ kind: "user" })).toEqual({ allowed: true, message: null });
		expect(await api.authorize(session(KANBAN, "orchestrator"))).toEqual({ allowed: true, message: null });
		expect(log).not.toHaveBeenCalled();

		const refused = await api.authorize(session("foo", "card", "process"));
		expect(refused.allowed).toBe(false);
		expect(refused.message).toContain("card t1 of foo can't");
		expect(log).toHaveBeenCalledWith(
			[KANBAN, "foo"],
			expect.objectContaining({ kind: "refused", action: "providers.authorizeSetup", taskId: "t1", from: "foo" }),
		);
		expect((await api.authorize({ kind: "unknown", reason: "the caller lookup failed" })).allowed).toBe(false);
	});
});
