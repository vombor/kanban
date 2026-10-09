import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AgentSessionIdentity, RuntimeCaller } from "../../../src/isolation/session-identity";
import { readKitSettingsHistory } from "../../../src/kits/project-settings";
import { getKitSettingsHistoryPath } from "../../../src/state/kanban-home";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createKitSettingsApi, decideKitSettingsCaller } from "../../../src/trpc/kit-settings-api";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

function session(workspaceId: string, role: AgentSessionIdentity["role"], taskId: string): RuntimeCaller {
	return {
		kind: "session",
		via: "credential",
		session: { workspaceId, taskId, role, agentId: "claude", cwd: `/projects/${workspaceId}` },
	};
}

const OWN_ORCHESTRATOR = session("foo", "orchestrator", "__home_agent__:foo:claude");
const OTHER_ORCHESTRATOR = session("bar", "orchestrator", "__home_agent__:bar:claude");
const OWN_CARD = session("foo", "card", "d1111");
const UNKNOWN: RuntimeCaller = { kind: "unknown", reason: "a credential outside its session's process tree" };

describe("kit settings caller rules", () => {
	it("allows the user and the project's own orchestrator, refuses everyone else", () => {
		expect(decideKitSettingsCaller({ kind: "user" }, "foo")).toEqual({ allowed: true, actor: { kind: "user" } });
		expect(decideKitSettingsCaller(OWN_ORCHESTRATOR, "foo")).toEqual({
			allowed: true,
			actor: { kind: "orchestrator", taskId: "__home_agent__:foo:claude" },
		});
		const refused = (caller: RuntimeCaller) => {
			const decision = decideKitSettingsCaller(caller, "foo");
			return decision.allowed ? "allowed" : decision.message;
		};
		expect(refused(OTHER_ORCHESTRATOR)).toContain("not the orchestrator of bar");
		expect(refused(OWN_CARD)).toContain("card d1111 of foo can't");
		expect(refused(UNKNOWN)).toContain("an unidentified agent session");
	});

	it("applies an allowed change at once and logs a refused one, writing nothing for it", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			mkdirSync(dirname(globalConfigPath), { recursive: true });
			writeFileSync(globalConfigPath, JSON.stringify({ workspaces: { foo: { kit: { name: "team" } } } }));
			const logged: Array<{ workspaceIds: readonly (string | null)[]; action: string; kind: string }> = [];
			const api = createKitSettingsApi({
				log: async (workspaceIds, record) => {
					logged.push({ workspaceIds, action: record.action, kind: record.kind });
				},
			});
			const set = (caller: RuntimeCaller) =>
				api.set({ caller, workspaceId: "foo", request: { key: "roles.fallback.model", value: "m1" } });

			for (const caller of [OTHER_ORCHESTRATOR, OWN_CARD, UNKNOWN]) {
				const response = await set(caller);
				expect(response.ok).toBe(false);
				expect(response.changes).toEqual([]);
			}
			expect(logged).toEqual([
				{ workspaceIds: ["foo", "bar"], action: "kit.set", kind: "refused" },
				{ workspaceIds: ["foo", "foo"], action: "kit.set", kind: "refused" },
				{ workspaceIds: ["foo", null], action: "kit.set", kind: "refused" },
			]);
			expect(JSON.parse(readFileSync(globalConfigPath, "utf8")).workspaces.foo.kit).toEqual({ name: "team" });

			const response = await set(OWN_ORCHESTRATOR);
			expect(response).toMatchObject({
				ok: true,
				kitName: "team",
				changes: [{ key: "roles.fallback.model", to: "m1" }],
			});
			expect(
				(
					await api.set({
						caller: { kind: "user" },
						workspaceId: "foo",
						request: { key: "onFail.then", value: "stop" },
					})
				).error,
			).toContain("part of the team definition");
			const unset = await api.unset({
				caller: { kind: "user" },
				workspaceId: "foo",
				request: { key: "roles.fallback.model" },
			});
			expect(unset.ok).toBe(true);
			expect((await readKitSettingsHistory(getKitSettingsHistoryPath("foo"))).map((entry) => entry.by)).toEqual([
				{ kind: "orchestrator", taskId: "__home_agent__:foo:claude" },
				{ kind: "user" },
			]);
		});
	});
});

describe("kit.set / kit.unset routes", () => {
	it("decide on the strict caller (the process-tree lookup), not the lazy one", async () => {
		const set = vi.fn(async () => ({ ok: true, kitName: "team", changes: [], historyPath: null }));
		const getCaller = vi.fn(async (): Promise<RuntimeCaller> => ({ kind: "user" }));
		const caller = runtimeAppRouter.createCaller({
			requestedWorkspaceId: "foo",
			workspaceScope: { workspaceId: "foo", workspacePath: "/projects/foo" },
			getCaller,
			resolveStrictCaller: async () => OWN_CARD,
			kitSettingsApi: { set, unset: set },
		} as unknown as RuntimeTrpcContext);
		await caller.kit.set({ key: "roles.dev.model", value: "m" });
		await caller.kit.unset({ key: "roles.dev.model" });
		expect(set.mock.calls).toEqual([
			[{ caller: OWN_CARD, workspaceId: "foo", request: { key: "roles.dev.model", value: "m" } }],
			[{ caller: OWN_CARD, workspaceId: "foo", request: { key: "roles.dev.model" } }],
		]);
	});
});
