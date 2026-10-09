import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadProjectShortcuts } from "../../../src/config/runtime-config";
import type { AgentSessionIdentity, RuntimeCaller } from "../../../src/isolation/session-identity";
import { createShortcutPortRegistry } from "../../../src/server/shortcut-ports";
import { getProjectKanbanConfigPath } from "../../../src/state/kanban-home";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createShortcutsApi, decideShortcutsCaller } from "../../../src/trpc/shortcuts-api";
import { createTempDir } from "../../utilities/temp-dir";

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

describe("shortcut caller rules", () => {
	it("allows the user and the project's own orchestrator, refuses cards, other orchestrators and unknown callers", () => {
		expect(decideShortcutsCaller(USER, "foo")).toEqual({ allowed: true, actor: { kind: "user" } });
		expect(decideShortcutsCaller(OWN_ORCHESTRATOR, "foo")).toEqual({
			allowed: true,
			actor: { kind: "orchestrator", taskId: "__home_agent__:foo:claude" },
		});
		for (const caller of [OTHER_ORCHESTRATOR, OWN_CARD, UNKNOWN]) {
			expect(decideShortcutsCaller(caller, "foo").allowed).toBe(false);
		}
		const other = decideShortcutsCaller(OTHER_ORCHESTRATOR, "foo");
		expect(other.allowed ? "" : other.message).toContain("foo's own orchestrator");
	});
});

describe("shortcuts api", () => {
	const temps: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const temp of temps.splice(0)) {
			temp.cleanup();
		}
	});

	const setup = () => {
		const temp = createTempDir("kanban-shortcuts-");
		temps.push(temp);
		const repoPath = join(temp.path, "foo");
		mkdirSync(repoPath, { recursive: true });
		const historyPath = join(temp.path, "history.jsonl");
		const logged: Array<{ action: string; kind: string }> = [];
		const onChanged = vi.fn();
		let nextPort = 41000;
		const api = createShortcutsApi({
			log: async (_workspaceIds, record) => {
				logged.push({ action: record.action, kind: record.kind });
			},
			ports: createShortcutPortRegistry({ askOs: async () => nextPort++ }),
			onChanged,
			historyPath,
		});
		const call = { workspaceId: "foo", repoPath };
		return { api, call, repoPath, historyPath, logged, onChanged };
	};

	it("refuses and logs a change from a card, another orchestrator or an unknown caller, writing nothing", async () => {
		const { api, call, repoPath, logged, onChanged } = setup();
		for (const caller of [OWN_CARD, OTHER_ORCHESTRATOR, UNKNOWN]) {
			const response = await api.add({ ...call, caller, request: { label: "Preview", command: "npm run dev" } });
			expect(response.ok).toBe(false);
			expect((await api.remove({ ...call, caller, request: { label: "Preview" } })).ok).toBe(false);
		}
		expect(logged).toHaveLength(6);
		expect(logged.every((entry) => entry.kind === "refused")).toBe(true);
		expect(await loadProjectShortcuts(repoPath)).toEqual([]);
		expect(onChanged).not.toHaveBeenCalled();
	});

	it("adds any shortcut, updates one by label in place, removes it, and logs each change with who made it", async () => {
		const { api, call, repoPath, historyPath, onChanged } = setup();
		const configPath = getProjectKanbanConfigPath(repoPath);
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, JSON.stringify({ shortcuts: [{ label: "Test", command: "npm test", icon: "bug" }] }));
		const added = await api.add({
			...call,
			caller: OWN_ORCHESTRATOR,
			request: { label: "Preview", command: "PORT={port} npm run dev", icon: "Play" },
		});
		expect(added).toMatchObject({ ok: true, change: { label: "Preview", to: { icon: "play" } } });
		const updated = await api.add({
			...call,
			caller: USER,
			request: { label: "test", command: "npm run test -- --run", icon: "build" },
		});
		expect(updated.change).toMatchObject({ from: { command: "npm test" }, to: { label: "test" } });
		expect((await loadProjectShortcuts(repoPath)).map((item) => item.label)).toEqual(["test", "Preview"]);
		const unchanged = await api.add({
			...call,
			caller: USER,
			request: { label: "test", command: "npm run test -- --run", icon: "build" },
		});
		expect(unchanged).toMatchObject({ ok: true, change: null });
		expect((await api.remove({ ...call, caller: USER, request: { label: "PREVIEW" } })).ok).toBe(true);
		expect((await api.remove({ ...call, caller: USER, request: { label: "Nope" } })).error).toContain("no shortcut");
		expect(JSON.parse(readFileSync(getProjectKanbanConfigPath(repoPath), "utf8"))).toEqual({
			shortcuts: [{ label: "test", command: "npm run test -- --run", icon: "build" }],
		});
		const history = readFileSync(historyPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(history.map((entry) => [entry.via, entry.label, entry.by.kind])).toEqual([
			["shortcut add", "Preview", "orchestrator"],
			["shortcut add", "test", "user"],
			["shortcut remove", "Preview", "user"],
		]);
		expect(onChanged).toHaveBeenCalledTimes(3);
	});

	it("refuses an unknown icon and a command of more than one line", async () => {
		const { api, call } = setup();
		const icon = await api.add({ ...call, caller: USER, request: { label: "A", command: "ls", icon: "rainbow" } });
		expect(icon.error).toContain('unknown icon "rainbow"');
		const lines = await api.add({ ...call, caller: USER, request: { label: "A", command: "ls\nrm -rf x" } });
		expect(lines.error).toContain("one line");
	});

	it("fills {port} and {url} for the user's run, a new port each time, and leaves other commands as they are", async () => {
		const { api, call } = setup();
		await api.add({
			...call,
			caller: USER,
			request: { label: "Preview", command: 'echo "open {url}health" && PORT={port} npm run dev' },
		});
		await api.add({ ...call, caller: USER, request: { label: "Lint", command: "npm run lint" } });
		const run = (label: string, caller: RuntimeCaller = USER) =>
			api.prepareRun({
				...call,
				caller,
				request: { label, taskId: "d1111", origin: "http://localhost:3485/foo?x=1" },
			});
		expect(await run("Preview")).toEqual({
			ok: true,
			command: 'echo "open http://localhost:3485/api/shortcut-port/41000/health" && PORT=41000 npm run dev',
			port: 41000,
			url: "http://localhost:3485/api/shortcut-port/41000/",
		});
		expect((await run("Preview")).port).toBe(41001);
		expect(await run("Lint")).toEqual({ ok: true, command: "npm run lint", port: null, url: null });
		expect((await run("Preview", OWN_ORCHESTRATOR)).ok).toBe(false);
		expect((await run("Missing")).error).toContain('no shortcut "Missing"');
	});
});

describe("shortcuts routes", () => {
	it("decide on the strict caller (the process-tree lookup), not the lazy one", async () => {
		const change = vi.fn(async (_input: { caller: RuntimeCaller }) => ({ ok: true, shortcuts: [], change: null }));
		const caller = runtimeAppRouter.createCaller({
			requestedWorkspaceId: "foo",
			workspaceScope: { workspaceId: "foo", workspacePath: "/projects/foo" },
			getCaller: async () => USER,
			resolveStrictCaller: async () => OWN_CARD,
			shortcutsApi: { list: vi.fn(), add: change, remove: change, prepareRun: vi.fn() },
		} as unknown as RuntimeTrpcContext);
		await caller.shortcuts.add({ label: "Preview", command: "npm run dev" });
		await caller.shortcuts.remove({ label: "Preview" });
		expect(change.mock.calls.map(([input]) => input.caller)).toEqual([OWN_CARD, OWN_CARD]);
	});
});
