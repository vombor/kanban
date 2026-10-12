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
			writeFileSync(globalConfigPath, JSON.stringify({ workspaces: { foo: { kit: { name: "team-cloud" } } } }));
			const logged: Array<{ workspaceIds: readonly (string | null)[]; action: string; kind: string }> = [];
			const api = createKitSettingsApi({
				log: async (workspaceIds, record) => {
					logged.push({ workspaceIds, action: record.action, kind: record.kind });
				},
			});
			const set = (caller: RuntimeCaller) =>
				api.set({
					caller,
					workspaceId: "foo",
					request: { key: "roles.fallback.model", value: "us.moonshotai.kimi-k3" },
				});

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
			expect(JSON.parse(readFileSync(globalConfigPath, "utf8")).workspaces.foo.kit).toEqual({ name: "team-cloud" });

			// Any model may be on any role: Kanban keeps no list of allowed models.
			const anyModel = await api.set({
				caller: OWN_ORCHESTRATOR,
				workspaceId: "foo",
				request: { key: "roles.fallback.model", value: "m1" },
			});
			expect(anyModel).toMatchObject({ ok: true, changes: [{ key: "roles.fallback.model", to: "m1" }] });

			const response = await set(OWN_ORCHESTRATOR);
			expect(response).toMatchObject({
				ok: true,
				kitName: "team-cloud",
				changes: [{ key: "roles.fallback.model", to: "us.moonshotai.kimi-k3" }],
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
				{ kind: "orchestrator", taskId: "__home_agent__:foo:claude" },
				{ kind: "user" },
			]);
		});
	});
});

describe("kit apply through the route", () => {
	it("lets the user and the project's own orchestrator switch its kit, and refuses another orchestrator and a card", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			mkdirSync(dirname(globalConfigPath), { recursive: true });
			writeFileSync(
				globalConfigPath,
				JSON.stringify({
					workspaces: {
						foo: {
							landing: { mode: "off" },
							kit: { name: "team-cloud", overrides: { "qa.blurb": "Foo", "tiers.tier2.1.model": "m-senior" } },
						},
					},
				}),
			);
			const logged: string[] = [];
			const api = createKitSettingsApi({
				log: async (_workspaceIds, record) => {
					logged.push(`${record.action} ${record.kind}`);
				},
			});
			const readKit = () => JSON.parse(readFileSync(globalConfigPath, "utf8")).workspaces.foo.kit;
			for (const caller of [OTHER_ORCHESTRATOR, OWN_CARD, UNKNOWN]) {
				const response = await api.apply({ caller, workspaceId: "foo", request: { kitName: "team-local" } });
				expect(response).toMatchObject({ ok: false, result: null });
			}
			expect(logged).toEqual(["kit.apply refused", "kit.apply refused", "kit.apply refused"]);
			expect(readKit().name).toBe("team-cloud");

			// The orchestrator switches its own project's kit; a setting that doesn't fit team-local is dropped.
			const switched = await api.apply({
				caller: OWN_ORCHESTRATOR,
				workspaceId: "foo",
				request: { kitName: "team-local" },
			});
			expect(switched.ok).toBe(true);
			expect(switched.result).toMatchObject({
				kitName: { from: "team-cloud", to: "team-local" },
				written: true,
				dropped: [
					{ key: "tiers.tier2.1.model", value: "m-senior", why: expect.stringContaining('no tier "tier2"') },
				],
				historyPath: getKitSettingsHistoryPath("foo"),
			});
			expect(readKit()).toEqual({ name: "team-local", overrides: { "qa.blurb": "Foo" } });

			// Landing mode and removing a stored team key stay the user's.
			const landing = await api.apply({
				caller: OWN_ORCHESTRATOR,
				workspaceId: "foo",
				request: { kitName: "team-cloud", landing: "qa" },
			});
			expect(landing).toMatchObject({ ok: false, error: expect.stringContaining("landing mode is the user's") });
			expect(readKit().name).toBe("team-local");

			const byUser = await api.apply({
				caller: { kind: "user" },
				workspaceId: "foo",
				request: { kitName: "team-cloud", landing: "qa", set: { "roles.dev.model": "m-dev" } },
			});
			expect(byUser.ok).toBe(true);
			const stored = JSON.parse(readFileSync(globalConfigPath, "utf8")).workspaces.foo;
			expect(stored.kit).toEqual({
				name: "team-cloud",
				overrides: { "qa.blurb": "Foo", "roles.dev.model": "m-dev" },
			});
			expect(stored.landing).toEqual({ mode: "qa" });

			const history = await readKitSettingsHistory(getKitSettingsHistoryPath("foo"));
			expect(history.map(({ key, by, via }) => ({ key, by: by.kind, via }))).toEqual([
				{ key: "(kit)", by: "orchestrator", via: "kit apply" },
				{ key: "tiers.tier2.1.model", by: "orchestrator", via: "kit apply" },
				{ key: "(kit)", by: "user", via: "kit apply" },
				{ key: "roles.dev.model", by: "user", via: "kit apply" },
			]);
		});
	});
});

describe("kit.set / kit.unset / kit.applyKit routes", () => {
	it("decide on the strict caller (the process-tree lookup), not the lazy one", async () => {
		const set = vi.fn(async () => ({ ok: true, kitName: "team-cloud", changes: [], historyPath: null }));
		const apply = vi.fn(async () => ({ ok: false, result: null, error: "refused" }));
		const getCaller = vi.fn(async (): Promise<RuntimeCaller> => ({ kind: "user" }));
		const caller = runtimeAppRouter.createCaller({
			requestedWorkspaceId: "foo",
			workspaceScope: { workspaceId: "foo", workspacePath: "/projects/foo" },
			getCaller,
			resolveStrictCaller: async () => OWN_CARD,
			kitSettingsApi: { set, unset: set, apply },
		} as unknown as RuntimeTrpcContext);
		await caller.kit.set({ key: "roles.dev.model", value: "m" });
		await caller.kit.unset({ key: "roles.dev.model" });
		await caller.kit.applyKit({ kitName: "team-local" });
		expect(set.mock.calls).toEqual([
			[{ caller: OWN_CARD, workspaceId: "foo", request: { key: "roles.dev.model", value: "m" } }],
			[{ caller: OWN_CARD, workspaceId: "foo", request: { key: "roles.dev.model" } }],
		]);
		expect(apply.mock.calls).toEqual([
			[{ caller: OWN_CARD, workspaceId: "foo", request: { kitName: "team-local" } }],
		]);
		expect(getCaller).not.toHaveBeenCalled();
	});
});
