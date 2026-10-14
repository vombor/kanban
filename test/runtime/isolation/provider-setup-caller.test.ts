import { describe, expect, it, vi } from "vitest";
import { migrateLegacyConfigKeys, parsePipelineConfig } from "../../../src/config/pipeline-config";
import { decideUserInstanceCaller, USER_INSTANCE_COMMANDS } from "../../../src/isolation/cli-scope";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { createProviderSetupApi } from "../../../src/trpc/provider-setup-api";

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

describe("user-only instance administration", () => {
	it("starts without any projects or privileged project and ignores legacy privileges while preserving providers", () => {
		const fresh = parsePipelineConfig({}).config;
		expect(fresh.workspaces).toEqual({});
		expect(fresh.providers).toEqual({ openaiCompatible: {} });
		const raw = {
			providers: {
				setupWorkspaceId: "first-project",
				openaiCompatible: { custom: { name: "Custom", baseUrl: "http://example.test/v1", local: true } },
			},
		};
		expect(parsePipelineConfig(raw).config.providers).not.toHaveProperty("setupWorkspaceId");
		expect(parsePipelineConfig(raw).config.providers.openaiCompatible.custom?.name).toBe("Custom");
		const migrated = migrateLegacyConfigKeys(raw);
		expect(migrated.migrated).toContain("providers.setupWorkspaceId");
		expect(migrated.config.providers).toEqual({ openaiCompatible: raw.providers.openaiCompatible });
	});

	it("refuses every project's orchestrator and card, including the first project, for every administrative command", async () => {
		const log = vi.fn(async () => {});
		const api = createProviderSetupApi({ log });
		const callers: RuntimeCaller[] = [
			session("first-project", "orchestrator"),
			session("another-project", "orchestrator", "process"),
			session("first-project", "card"),
			session("another-project", "card", "process"),
			{ kind: "unknown", reason: "the caller lookup failed" },
		];
		for (const command of USER_INSTANCE_COMMANDS) {
			expect(decideUserInstanceCaller({ kind: "user" }, command)).toEqual({ allowed: true });
			expect(await api.authorize({ kind: "user" }, command)).toEqual({ allowed: true, message: null });
			for (const caller of callers) {
				expect(decideUserInstanceCaller(caller, command).allowed).toBe(false);
				const answer = await api.authorize(caller, command);
				expect(answer.allowed).toBe(false);
				expect(answer.message).toContain("only the user runs it");
				expect(answer.message).not.toContain("apart from");
			}
		}
		expect(log).toHaveBeenCalledWith(
			["first-project"],
			expect.objectContaining({ action: "providers.authorizeSetup", from: "first-project", to: null }),
		);
		expect(log).toHaveBeenCalledTimes(USER_INSTANCE_COMMANDS.length * callers.length);
	});
});
