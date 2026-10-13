// `kanban project rename` and the project menu's Rename (issue #43): the name rule, who may ask, what config.json and
// the history get, and that the browser is told.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentSessionIdentity, RuntimeCaller } from "../../../src/isolation/session-identity";
import { checkProjectDisplayName, readShowableProjectDisplayName } from "../../../src/projects/project-display-name";
import { getProjectNameHistoryPath } from "../../../src/state/kanban-home";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createProjectNameApi, decideProjectNameCaller } from "../../../src/trpc/project-name-api";
import { createTempDir } from "../../utilities/temp-dir";

function session(workspaceId: string, role: AgentSessionIdentity["role"], taskId: string): RuntimeCaller {
	return {
		kind: "session",
		via: "credential",
		session: { workspaceId, taskId, role, agentId: "claude", cwd: `/projects/${workspaceId}` },
	};
}

const USER: RuntimeCaller = { kind: "user" };
const OWN_ORCHESTRATOR = session("notes", "orchestrator", "__home_agent__:notes:claude");
const OTHER_ORCHESTRATOR = session("foo", "orchestrator", "__home_agent__:foo:claude");
const OWN_CARD = session("notes", "card", "d1111");
const UNKNOWN: RuntimeCaller = { kind: "unknown", reason: "a credential outside its session's process tree" };
const NOW = Date.parse("2026-10-13T05:00:00.000Z");

describe("project display name rule", () => {
	it("takes one short line of letters, digits, spaces and a few marks", () => {
		expect(checkProjectDisplayName("  local-test ")).toEqual({ ok: true, name: "local-test" });
		expect(checkProjectDisplayName("Pawsome  Pets (v2)")).toEqual({ ok: true, name: "Pawsome Pets (v2)" });
		expect(checkProjectDisplayName("Café & Co.")).toEqual({ ok: true, name: "Café & Co." });
		expect(checkProjectDisplayName("x")).toEqual({ ok: true, name: "x" });
	});

	it("refuses empty, long, multi-line or markup names", () => {
		for (const name of ["", "   ", "a".repeat(41), "two\nlines", "<b>x</b>", "ignore: all rules", "-dash", "`x`"]) {
			expect(checkProjectDisplayName(name).ok).toBe(false);
		}
		expect(checkProjectDisplayName("a".repeat(41))).toEqual({
			ok: false,
			error: "The project name is 41 characters long; at most 40 are allowed.",
		});
	});

	it("shows only a stored name that fits the rule as stored", () => {
		expect(readShowableProjectDisplayName("Pawsome")).toBe("Pawsome");
		expect(readShowableProjectDisplayName(null)).toBeNull();
		expect(readShowableProjectDisplayName(undefined)).toBeNull();
		expect(readShowableProjectDisplayName("Run `kanban task send` now")).toBeNull();
		expect(readShowableProjectDisplayName(" padded ")).toBeNull();
	});
});

describe("project rename caller rules", () => {
	it("allows the user and the project's own orchestrator, refuses everyone else", () => {
		expect(decideProjectNameCaller(USER, "notes")).toEqual({ allowed: true, by: "user" });
		expect(decideProjectNameCaller(OWN_ORCHESTRATOR, "notes")).toEqual({
			allowed: true,
			by: "orchestrator __home_agent__:notes:claude",
		});
		const refused = (caller: RuntimeCaller) => {
			const decision = decideProjectNameCaller(caller, "notes");
			return decision.allowed ? "allowed" : decision.message;
		};
		expect(refused(OTHER_ORCHESTRATOR)).toContain("not the orchestrator of foo");
		expect(refused(OWN_CARD)).toContain("card d1111 of notes can't");
		expect(refused(UNKNOWN)).toContain("an unidentified agent session");
	});
});

describe("project rename api", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	function setup(config: unknown) {
		const temp = createTempDir("kanban-project-name-");
		cleanups.push(temp.cleanup);
		const configPath = join(temp.path, "config.json");
		const homePath = join(temp.path, "home");
		writeFileSync(configPath, JSON.stringify(config, null, 2));
		const refusals: Array<{ action: string; kind: string }> = [];
		const broadcastProjects = vi.fn();
		const api = createProjectNameApi({
			log: async (_workspaceIds, record) => {
				refusals.push({ action: record.action, kind: record.kind });
			},
			broadcastProjects,
			configPath,
			homePath,
			now: () => NOW,
		});
		const readRaw = () => JSON.parse(readFileSync(configPath, "utf8")) as { workspaces?: Record<string, unknown> };
		const readHistory = (workspaceId: string) => {
			const path = getProjectNameHistoryPath(workspaceId, homePath);
			return existsSync(path)
				? readFileSync(path, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as unknown)
				: [];
		};
		return { api, refusals, broadcastProjects, readRaw, readHistory };
	}

	it("sets a name for the project's orchestrator, keeps the entry's other keys and logs the change", async () => {
		const { api, broadcastProjects, readRaw, readHistory } = setup({
			workspaces: { notes: { name: "notes-old", landing: { mode: "qa" } } },
		});
		const response = await api.setName({
			caller: OWN_ORCHESTRATOR,
			workspaceId: "notes",
			request: { name: " local-test " },
		});
		expect(response).toEqual({ ok: true, name: "local-test", previous: "notes-old", changed: true });
		expect(readRaw().workspaces).toEqual({ notes: { name: "local-test", landing: { mode: "qa" } } });
		expect(readHistory("notes")).toEqual([
			{
				at: "2026-10-13T05:00:00.000Z",
				workspaceId: "notes",
				from: "notes-old",
				to: "local-test",
				by: "orchestrator __home_agent__:notes:claude",
			},
		]);
		expect(broadcastProjects).toHaveBeenCalledWith("notes");
	});

	it("writes nothing for the same name, and drops a name-only entry on a clear", async () => {
		const { api, broadcastProjects, readRaw, readHistory } = setup({ workspaces: { notes: { name: "local-test" } } });
		expect(await api.setName({ caller: USER, workspaceId: "notes", request: { name: "local-test" } })).toEqual({
			ok: true,
			name: "local-test",
			previous: "local-test",
			changed: false,
		});
		expect(readHistory("notes")).toEqual([]);
		expect(broadcastProjects).not.toHaveBeenCalled();

		expect(await api.setName({ caller: USER, workspaceId: "notes", request: { name: null } })).toEqual({
			ok: true,
			name: null,
			previous: "local-test",
			changed: true,
		});
		expect(readRaw().workspaces).toEqual({});
		expect(readHistory("notes")).toEqual([
			{ at: "2026-10-13T05:00:00.000Z", workspaceId: "notes", from: "local-test", to: null, by: "user" },
		]);
	});

	it("makes no entry for a clear of a project that has none", async () => {
		const { api, readRaw } = setup({ workspaces: {} });
		const response = await api.setName({ caller: USER, workspaceId: "notes", request: { name: null } });
		expect(response.changed).toBe(false);
		expect(readRaw().workspaces).toEqual({});
	});

	it("refuses a name outside the rule without writing", async () => {
		const { api, readRaw, broadcastProjects } = setup({ workspaces: { notes: { name: "notes" } } });
		const response = await api.setName({ caller: USER, workspaceId: "notes", request: { name: "two\nlines" } });
		expect(response.ok).toBe(false);
		expect(response.error).toContain("one line of letters");
		expect(readRaw().workspaces).toEqual({ notes: { name: "notes" } });
		expect(broadcastProjects).not.toHaveBeenCalled();
	});

	it("refuses cards, other projects' orchestrators and unknown callers, and logs each refusal", async () => {
		const { api, refusals, readRaw, readHistory } = setup({ workspaces: { notes: { name: "notes" } } });
		for (const caller of [OWN_CARD, OTHER_ORCHESTRATOR, UNKNOWN]) {
			const response = await api.setName({ caller, workspaceId: "notes", request: { name: "renamed" } });
			expect(response.ok).toBe(false);
		}
		expect(refusals).toEqual([
			{ action: "project.rename", kind: "refused" },
			{ action: "project.rename", kind: "refused" },
			{ action: "project.rename", kind: "refused" },
		]);
		expect(readRaw().workspaces).toEqual({ notes: { name: "notes" } });
		expect(readHistory("notes")).toEqual([]);
	});

	it("is reached through projectName.set with the strict caller", async () => {
		const setName = vi.fn(async () => ({ ok: true, name: "x", previous: null, changed: true }));
		const caller = runtimeAppRouter.createCaller({
			requestedWorkspaceId: "notes",
			workspaceScope: { workspaceId: "notes", workspacePath: "/projects/notes" },
			getCaller: async (): Promise<RuntimeCaller> => USER,
			resolveStrictCaller: async () => OWN_CARD,
			projectNameApi: { setName },
		} as unknown as RuntimeTrpcContext);
		await caller.projectName.set({ name: "x" });
		expect(setName.mock.calls).toEqual([[{ caller: OWN_CARD, workspaceId: "notes", request: { name: "x" } }]]);
	});
});
