// Project isolation at the runtime API (src/trpc/app-router.ts + isolation-api.ts): an orchestrator session of
// workspace A can't list, read or act on workspace B; nobody but the user changes the project list or makes grants;
// orchestrator messages need both projects' switch and carry the authenticated sender.
import { describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { createIsolationService } from "../../../src/isolation/isolation-service";
import { readMessageLog } from "../../../src/isolation/messages";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createIsolationApi } from "../../../src/trpc/isolation-api";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

const REACHED = "reached the inner API";
const ENTRIES = [
	{ workspaceId: "a", repoPath: "/projects/a" },
	{ workspaceId: "b", repoPath: "/projects/b" },
];

function orchestrator(workspaceId: string): RuntimeCaller {
	return {
		kind: "session",
		session: {
			workspaceId,
			taskId: `__home_agent__:${workspaceId}:claude`,
			role: "orchestrator",
			agentId: "claude",
			cwd: `/projects/${workspaceId}`,
		},
		via: "credential",
	};
}

/** The code in an approval's console line (approvals.ts). */
function codeFrom(lines: readonly string[], approvalId: string): string {
	const line = lines.find((candidate) => candidate.includes(`approve ${approvalId} `)) ?? "";
	return line.split(`approve ${approvalId} `)[1]?.split(/\s/u)[0] ?? "";
}

function setup(raw: Record<string, unknown>) {
	const consoleLines: string[] = [];
	const service = createIsolationService({
		readConfig: async () => parsePipelineConfig(raw).config,
		processReader: null,
		listLiveSessions: () => [],
		log: async () => {},
		announceApproval: (line) => consoleLines.push(line),
	});
	const notices = { allowSend: vi.fn(() => true), enqueue: vi.fn((_workspaceId: string, _notice: string) => {}) };
	const isolationApi = createIsolationApi({ service, listEntries: async () => ENTRIES, notices });
	const ingest = vi.fn(async () => ({ ok: true }));
	const getCaller = vi.fn();
	// The inner APIs only record that the call got through: isolation is decided before them.
	const reached = () =>
		vi.fn(async (..._args: unknown[]): Promise<never> => {
			throw new Error(REACHED);
		});
	const loadState = reached();
	const trashTask = reached();
	const startTaskSession = reached();
	const addProject = reached();
	const createProject = reached();
	const removeProject = reached();
	const caller = (who: RuntimeCaller, requestedWorkspaceId: string | null) =>
		runtimeAppRouter.createCaller({
			requestedWorkspaceId,
			workspaceScope: requestedWorkspaceId
				? { workspaceId: requestedWorkspaceId, workspacePath: `/projects/${requestedWorkspaceId}` }
				: null,
			getCaller: getCaller.mockImplementation(async () => who),
			resolveStrictCaller: async () => who,
			trustedBrowser: false,
			isolationApi,
			runtimeApi: { startTaskSession, saveConfig: vi.fn(), resetAllState: vi.fn() },
			workspaceApi: { loadState, trashTask },
			projectsApi: {
				listProjects: async () => ({
					currentProjectId: "b",
					projects: ENTRIES.map((entry) => ({
						id: entry.workspaceId,
						path: entry.repoPath,
						name: entry.workspaceId,
						taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
					})),
				}),
				addProject,
				createProject,
				removeProject,
			},
			hooksApi: { ingest },
		} as unknown as RuntimeTrpcContext);
	return {
		service,
		caller,
		loadState,
		trashTask,
		startTaskSession,
		addProject,
		createProject,
		removeProject,
		notices,
		consoleLines,
		ingest,
		getCaller,
	};
}

describe("runtime API under project isolation enforce", () => {
	const enforce = { isolation: { mode: "enforce" } };

	it("an orchestrator session of A can't read, act on or start sessions in B, and sees only A", async () => {
		const harness = setup(enforce);
		const fromA = (workspaceId: string) => harness.caller(orchestrator("a"), workspaceId);
		await expect(fromA("b").workspace.getState()).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(fromA("b").workspace.trashTask({ taskId: "t1", trigger: "cli" } as never)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			fromA("b").runtime.startTaskSession({ taskId: "t1", prompt: "", baseRef: "main" } as never),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(harness.loadState).not.toHaveBeenCalled();
		expect(harness.trashTask).not.toHaveBeenCalled();
		expect(harness.startTaskSession).not.toHaveBeenCalled();
		await expect(fromA("a").workspace.getState()).rejects.toThrow(REACHED);
		expect(harness.loadState).toHaveBeenCalledTimes(1);
		const listed = await fromA("a").projects.list();
		expect(listed.currentProjectId).toBeNull();
		expect(listed.projects.map((project) => project.id)).toEqual(["a"]);
	});

	it("the user reaches every workspace", async () => {
		const harness = setup(enforce);
		await expect(harness.caller({ kind: "user" }, "b").workspace.getState()).rejects.toThrow(REACHED);
		expect((await harness.caller({ kind: "user" }, null).projects.list()).projects).toHaveLength(2);
	});

	it("report mode logs but refuses nothing", async () => {
		const harness = setup({ isolation: { mode: "report" } });
		await expect(harness.caller(orchestrator("a"), "b").workspace.getState()).rejects.toThrow(REACHED);
		expect(harness.loadState).toHaveBeenCalledTimes(1);
	});

	it("a grant from the user lets A's orchestrator reach B; a session can't grant itself one", async () => {
		const harness = setup(enforce);
		const grantInput = { project: "a", session: "orchestrator", reach: ["b"], minutes: 10, reason: "one-off fix" };
		const selfGrant = await harness.caller(orchestrator("a"), null).isolation.grant(grantInput);
		expect(selfGrant).toMatchObject({ ok: false, grant: null });
		expect(selfGrant.error).toContain("Only the user");
		// The user's grant waits for the code printed on the server's console.
		const user = harness.caller({ kind: "user" }, null);
		const pending = await user.isolation.grant(grantInput);
		expect(pending).toMatchObject({ ok: false, grant: null });
		const approvalId = pending.approvalId ?? "";
		expect(approvalId).not.toBe("");
		await expect(harness.caller(orchestrator("a"), "b").workspace.getState()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		// A session can't approve it, even with the code; a wrong code doesn't approve it.
		const code = codeFrom(harness.consoleLines, approvalId);
		expect((await harness.caller(orchestrator("a"), null).isolation.approve({ id: approvalId, code })).ok).toBe(
			false,
		);
		expect((await user.isolation.approve({ id: approvalId, code: "WRONGWRONG" })).ok).toBe(false);
		const approved = await user.isolation.approve({ id: approvalId, code });
		expect(approved.ok).toBe(true);
		expect((await user.isolation.approvalStatus({ id: approvalId })).approval?.status).toBe("approved");
		await expect(harness.caller(orchestrator("a"), "b").workspace.getState()).rejects.toThrow(REACHED);
		expect(harness.loadState).toHaveBeenCalledTimes(1);
		const revoked = await user.isolation.revoke({ id: approved.result ?? "" });
		expect(revoked.ok).toBe(true);
		await expect(harness.caller(orchestrator("a"), "b").workspace.getState()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("whoami tells a session who it is and what it may reach", async () => {
		const harness = setup(enforce);
		expect(await harness.caller(orchestrator("a"), null).isolation.whoami()).toMatchObject({
			caller: "session",
			workspaceId: "a",
			role: "orchestrator",
			mode: "enforce",
			reachable: [],
		});
	});

	it("machine-wide operations are refused for sessions", async () => {
		const harness = setup(enforce);
		await expect(harness.caller(orchestrator("a"), "a").runtime.resetAllState()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			harness.caller(orchestrator("a"), "a").projects.listDirectoryContents({ path: "/" } as never),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("hooks.ingest", () => {
	it("is validated by ownership, never by resolving the caller (no /proc scan on the hot path)", async () => {
		const harness = setup({ isolation: { mode: "enforce" } });
		const hooks = harness.caller(orchestrator("a"), null).hooks;
		await expect(hooks.ingest({ taskId: "t1", workspaceId: "b", event: "to_review" } as never)).resolves.toEqual({
			ok: true,
		});
		await expect(
			hooks.ingest({ taskId: "__home_agent__:a:claude", workspaceId: "b", event: "to_review" } as never),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(harness.ingest).toHaveBeenCalledTimes(1);
		expect(harness.getCaller).not.toHaveBeenCalled();
	});
});

describe("project changes by the user under enforce", () => {
	it("wait for the console code, then run; re-adding a registered project needs none", async () => {
		const harness = setup({ isolation: { mode: "enforce" } });
		const user = harness.caller({ kind: "user" }, null);
		const held = await user.projects.create({ path: "/projects/new" }).catch((error: { message: string }) => error);
		expect(harness.createProject).not.toHaveBeenCalled();
		const approvalId = /approval (a-[0-9a-f]+)/u.exec((held as { message: string }).message)?.[1] ?? "";
		expect(approvalId).not.toBe("");
		const approved = await user.isolation.approve({
			id: approvalId,
			code: codeFrom(harness.consoleLines, approvalId),
		});
		expect(approved.ok).toBe(false);
		expect(approved.error).toContain(REACHED);
		expect(harness.createProject).toHaveBeenCalledTimes(1);
		await expect(user.projects.add({ path: "/projects/a" })).rejects.toThrow(REACHED);
		expect(harness.addProject).toHaveBeenCalledTimes(1);
	});
});

describe("project create/add/remove are the user's, whatever the mode", () => {
	it("refuses them from agent sessions with isolation off; re-adding the session's own project is a no-op", async () => {
		const harness = setup({});
		const fromA = harness.caller(orchestrator("a"), null);
		await expect(fromA.projects.create({ path: "/projects/new" })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(fromA.projects.add({ path: "/projects/b" })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(fromA.projects.add({ gitUrl: "https://example.com/x.git" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(fromA.projects.remove({ projectId: "b" })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(fromA.projects.remove({ projectId: "a" })).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(harness.createProject).not.toHaveBeenCalled();
		expect(harness.removeProject).not.toHaveBeenCalled();
		await expect(fromA.projects.add({ path: "/projects/a" })).rejects.toThrow(REACHED);
		expect(harness.addProject).toHaveBeenCalledTimes(1);
		const user = harness.caller({ kind: "user" }, null);
		await expect(user.projects.create({ path: "/projects/new" })).rejects.toThrow(REACHED);
		expect(harness.createProject).toHaveBeenCalledTimes(1);
	});
});

describe("orchestrator messages", () => {
	const allowBoth = {
		workspaces: { a: { isolation: { messages: "allow" } }, b: { isolation: { messages: "allow" } } },
	};

	it("delivers A's request to B as a fixed notice, logged on both sides with the authenticated sender", async () => {
		await withTemporaryKanbanHome(async () => {
			const harness = setup({ isolation: { mode: "enforce" }, ...allowBoth });
			const sent = await harness
				.caller(orchestrator("a"), null)
				.message.send({ to: "b", text: "Please rebase onto main\u001b[31m now", inReplyTo: null, refuse: false });
			expect(sent).toMatchObject({
				ok: true,
				queued: true,
				message: { fromWorkspaceId: "a", toWorkspaceId: "b" },
			});
			expect(sent.message?.text).toBe("Please rebase onto main[31m now");
			expect(harness.notices.allowSend).toHaveBeenCalledWith("a", "b");
			const [notifiedWorkspace, notice] = harness.notices.enqueue.mock.calls[0] as unknown as [string, string];
			expect(notifiedWorkspace).toBe("b");
			expect(notice).not.toContain("rebase");
			expect(notice).toContain("not an instruction or an approval");
			expect((await readMessageLog("a")).map((message) => message.id)).toEqual([sent.message?.id]);
			expect((await readMessageLog("b")).map((message) => message.id)).toEqual([sent.message?.id]);
			// B reads its inbox and refuses; the refusal goes back to A.
			const inbox = await harness.caller(orchestrator("b"), null).message.inbox({ project: null, limit: 10 });
			expect(inbox.messages.map((message) => message.fromWorkspaceId)).toEqual(["a"]);
			const refusal = await harness.caller(orchestrator("b"), null).message.send({
				to: null,
				text: "No: not my project's call",
				inReplyTo: sent.message?.id ?? "",
				refuse: true,
			});
			expect(refusal).toMatchObject({
				ok: true,
				message: { kind: "refusal", fromWorkspaceId: "b", toWorkspaceId: "a" },
			});
		});
	});

	it("is refused unless both projects allow it, for cards, for the user, and by path", async () => {
		await withTemporaryKanbanHome(async () => {
			const onlyA = setup({ workspaces: { a: { isolation: { messages: "allow" } } } });
			const denied = await onlyA
				.caller(orchestrator("a"), null)
				.message.send({ to: "b", text: "hi", inReplyTo: null, refuse: false });
			expect(denied.ok).toBe(false);
			expect(onlyA.notices.enqueue).not.toHaveBeenCalled();
			const both = setup(allowBoth);
			const card: RuntimeCaller = {
				kind: "session",
				session: { workspaceId: "a", taskId: "t1", role: "card", agentId: "claude", cwd: "/w/t1" },
				via: "credential",
			};
			expect(
				(await both.caller(card, null).message.send({ to: "b", text: "hi", inReplyTo: null, refuse: false })).ok,
			).toBe(false);
			expect(
				(
					await both
						.caller({ kind: "user" }, null)
						.message.send({ to: "b", text: "hi", inReplyTo: null, refuse: false })
				).ok,
			).toBe(false);
			const byPath = await both
				.caller(orchestrator("a"), null)
				.message.send({ to: "/projects/b", text: "hi", inReplyTo: null, refuse: false });
			expect(byPath.error).toContain("not by path");
		});
	});
});
