// Child credentials (src/isolation/isolation-service.ts issueChildCredential/bindChildCredential, issue #6): a session
// hands a detached process it spawned itself (`kanban bench calibrate`) a credential of its own, with the session's
// identity, bound to that process's pid. Only the owning session binds it, only to its own child, and it ends with that
// process. Driven through the real service and router with a fake /proc.
import { describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import {
	type CallerRequest,
	createIsolationService,
	type LiveAgentSession,
} from "../../../src/isolation/isolation-service";
import {
	type AgentSessionIdentity,
	createSessionCredentialRegistry,
	MAX_SESSION_CREDENTIALS,
	MAX_UNBOUND_CHILD_CREDENTIALS_PER_SESSION,
} from "../../../src/isolation/session-identity";
import type { ProcessEntry, ProcessTableReader } from "../../../src/server/process-table";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createIsolationApi } from "../../../src/trpc/isolation-api";

function processEntry(pid: number, ppid: number, extra: Partial<ProcessEntry> = {}): ProcessEntry {
	return {
		pid,
		ppid,
		state: "S",
		startTime: "1",
		kernelThread: false,
		command: `p${pid}`,
		cwd: null,
		cwdDeleted: false,
		exe: null,
		exeDeleted: false,
		rssBytes: 0,
		...extra,
	};
}

// The server is pid 10. Orchestrator of A: PTY child 200, its shell 250, the calibrate command 300. Card of B: PTY
// child 600, a CLI in it 650. Each calling process holds one loopback socket to the server's port 3484 (0x0D9C).
const SERVER_PORT = 3484;
const CLIENT_PORTS: Record<number, number> = { 300: 40000, 650: 40001, 500: 40002, 700: 40003 };

interface FakeProc {
	processes: ProcessEntry[];
}

function hexPort(port: number): string {
	return port.toString(16).toUpperCase().padStart(4, "0");
}

function fakeReader(proc: FakeProc): ProcessTableReader {
	return {
		list: async () => proc.processes,
		read: async (pid) => proc.processes.find((entry) => entry.pid === pid) ?? null,
		readSocketInodes: async (pid) => (CLIENT_PORTS[pid] ? [`inode-${pid}`] : []),
		readNetSockets: async () => ({
			tcp: Object.entries(CLIENT_PORTS).map(([pid, port]) => ({
				inode: `inode-${pid}`,
				local: `0100007F:${hexPort(port)}`,
				remote: `0100007F:${hexPort(SERVER_PORT)}`,
				state: "01",
			})),
			unix: [],
		}),
	};
}

function requestFrom(pid: number, credential: string | null): CallerRequest {
	return {
		credential,
		connection: { remoteAddress: "127.0.0.1", remotePort: CLIENT_PORTS[pid], localPort: SERVER_PORT },
		connectionKey: null,
	};
}

const ORCHESTRATOR_A: AgentSessionIdentity = {
	workspaceId: "a",
	taskId: "__home_agent__:a:claude",
	role: "orchestrator",
	agentId: "claude",
	cwd: "/projects/a",
};
const CARD_B: AgentSessionIdentity = { workspaceId: "b", taskId: "t9", role: "card", agentId: "codex", cwd: "/w/t9" };

function setup(raw: Record<string, unknown> = {}) {
	const proc: FakeProc = {
		processes: [
			processEntry(10, 1),
			processEntry(200, 10),
			processEntry(250, 200),
			processEntry(300, 250),
			processEntry(600, 10),
			processEntry(650, 600),
		],
	};
	const alive = new Set([200, 600]);
	const sessions: LiveAgentSession[] = [
		{ workspaceId: "a", taskId: ORCHESTRATOR_A.taskId, agentId: "claude", pid: 200, cwd: "/projects/a", live: true },
		{ workspaceId: "b", taskId: "t9", agentId: "codex", pid: 600, cwd: "/w/t9", live: true },
	];
	const log = vi.fn(async () => {});
	let now = 1_000_000;
	const service = createIsolationService({
		readConfig: async () => parsePipelineConfig(raw).config,
		processReader: fakeReader(proc),
		listLiveSessions: () => sessions,
		log,
		now: () => now,
		isPidAlive: (pid) => alive.has(pid) || proc.processes.some((entry) => entry.pid === pid),
		announceApproval: () => {},
	});
	const orchestratorCredential = service.credentials.issue(ORCHESTRATOR_A);
	const cardCredential = service.credentials.issue(CARD_B);
	/** The calibrate command (300) spawns its detached worker as pid 500. */
	const spawnWorker = (startTime = "7") => {
		proc.processes.push(processEntry(500, 300, { startTime }));
	};
	/** The calibrate command exits: its worker is reparented to init. */
	const detach = () => {
		proc.processes = proc.processes.filter((entry) => entry.pid !== 300);
		proc.processes = proc.processes.map((entry) => (entry.pid === 500 ? { ...entry, ppid: 1 } : entry));
	};
	const exitWorker = () => {
		proc.processes = proc.processes.filter((entry) => entry.pid !== 500);
	};
	return {
		service,
		proc,
		log,
		orchestratorCredential,
		cardCredential,
		spawnWorker,
		detach,
		exitWorker,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

async function issueAndBind(harness: ReturnType<typeof setup>): Promise<string> {
	const issued = await harness.service.issueChildCredential(requestFrom(300, harness.orchestratorCredential));
	if (!issued.ok) {
		throw new Error(issued.error);
	}
	harness.spawnWorker();
	const bound = await harness.service.bindChildCredential(
		requestFrom(300, harness.orchestratorCredential),
		issued.credential,
		500,
	);
	expect(bound).toMatchObject({ ok: true });
	return issued.credential;
}

describe("child credentials", () => {
	it("a detached child keeps its session's identity (same project and role) after its parent exits", async () => {
		const harness = setup();
		const child = await issueAndBind(harness);
		harness.detach();
		// The session's own credential would be outside its process tree here.
		expect(await harness.service.resolveCaller(requestFrom(500, harness.orchestratorCredential))).toMatchObject({
			kind: "unknown",
			reason: "credential used outside its session's process tree",
		});
		expect(await harness.service.resolveCaller(requestFrom(500, child))).toEqual({
			kind: "session",
			session: ORCHESTRATOR_A,
			via: "credential",
		});
		// The session's own credential is unchanged, and a relaunch of the session doesn't drop the child's.
		expect(harness.service.credentials.current("a", ORCHESTRATOR_A.taskId)).toBe(harness.orchestratorCredential);
		harness.service.credentials.issue(ORCHESTRATOR_A);
		expect((await harness.service.resolveCaller(requestFrom(500, child))).kind).toBe("session");
		expect(harness.log).toHaveBeenCalledWith("a", expect.objectContaining({ kind: "child_credential" }));
	});

	it("is unusable until bound, and never stands for the parent session's tree", async () => {
		const harness = setup();
		const issued = await harness.service.issueChildCredential(requestFrom(300, harness.orchestratorCredential));
		expect(issued.ok).toBe(true);
		const credential = issued.ok ? issued.credential : "";
		expect(await harness.service.resolveCaller(requestFrom(300, credential))).toMatchObject({ kind: "unknown" });
	});

	it("refuses the bind from another session, and the issue to a caller without its own credential", async () => {
		const harness = setup();
		const issued = await harness.service.issueChildCredential(requestFrom(300, harness.orchestratorCredential));
		const credential = issued.ok ? issued.credential : "";
		harness.spawnWorker();
		// Card t9 of B, calling from its own tree with its own credential, can't bind A's child credential.
		expect(
			await harness.service.bindChildCredential(requestFrom(650, harness.cardCredential), credential, 500),
		).toEqual({ ok: false, error: "not a child credential of the calling session" });
		// A's credential copied into B's tree is no session at all.
		expect(
			await harness.service.bindChildCredential(requestFrom(650, harness.orchestratorCredential), credential, 500),
		).toMatchObject({ ok: false });
		// No credential (the user's shell) or a child credential gets none.
		expect(await harness.service.issueChildCredential(requestFrom(300, null))).toMatchObject({ ok: false });
		expect(await harness.service.issueChildCredential(requestFrom(300, credential))).toMatchObject({ ok: false });
		// Nothing was bound: the owner can still bind it.
		expect(
			await harness.service.bindChildCredential(requestFrom(300, harness.orchestratorCredential), credential, 500),
		).toMatchObject({ ok: true });
	});

	it("refuses a pid that isn't the calling process's own live child, and a second bind", async () => {
		const harness = setup();
		const issued = await harness.service.issueChildCredential(requestFrom(300, harness.orchestratorCredential));
		const credential = issued.ok ? issued.credential : "";
		const fromOwner = requestFrom(300, harness.orchestratorCredential);
		// A process elsewhere (child of init), the session's own PTY child (a grandparent), a missing pid, a zombie.
		harness.proc.processes.push(processEntry(700, 1), processEntry(800, 300, { state: "Z" }));
		for (const pid of [700, 200, 250, 999, 800]) {
			expect(await harness.service.bindChildCredential(fromOwner, credential, pid)).toEqual({
				ok: false,
				error: `process ${pid} is not a live child of the calling process`,
			});
		}
		harness.spawnWorker();
		expect(await harness.service.bindChildCredential(fromOwner, credential, 500)).toMatchObject({ ok: true });
		expect(await harness.service.bindChildCredential(fromOwner, credential, 500)).toEqual({
			ok: false,
			error: "that child credential is already bound",
		});
	});

	it("ends when the child exits, and a reused pid isn't the child", async () => {
		const harness = setup();
		const child = await issueAndBind(harness);
		harness.detach();
		harness.exitWorker();
		expect(await harness.service.resolveCaller(requestFrom(500, child))).toMatchObject({ kind: "unknown" });
		// Pid 500 reused by another process (another start time) under init.
		harness.proc.processes.push(processEntry(500, 1, { startTime: "99" }));
		expect(await harness.service.resolveCaller(requestFrom(500, child))).toMatchObject({ kind: "unknown" });
		harness.exitWorker();
		harness.advance(61_000);
		harness.service.pruneCredentials();
		expect(harness.service.credentials.resolve(child)).toBeNull();
	});

	it("an unbound child credential is dropped after the start grace", async () => {
		const harness = setup();
		const issued = await harness.service.issueChildCredential(requestFrom(300, harness.orchestratorCredential));
		const credential = issued.ok ? issued.credential : "";
		harness.advance(61_000);
		harness.service.pruneCredentials();
		expect(harness.service.credentials.resolve(credential)).toBeNull();
	});
});

describe("a detached calibrate child at the runtime API", () => {
	function router(harness: ReturnType<typeof setup>, pid: number, credential: string | null, workspaceId: string) {
		const isolationApi = createIsolationApi({
			service: harness.service,
			listEntries: async () => [
				{ workspaceId: "a", repoPath: "/projects/a" },
				{ workspaceId: "b", repoPath: "/projects/b" },
			],
			notices: { allowSend: () => true, enqueue: () => {} },
		});
		const request = requestFrom(pid, credential);
		const startTaskSession = vi.fn(async () => ({ ok: true, summary: null }));
		const caller = runtimeAppRouter.createCaller({
			requestedWorkspaceId: workspaceId,
			workspaceScope: { workspaceId, workspacePath: `/projects/${workspaceId}` },
			getCaller: async () => await harness.service.resolveCaller(request),
			resolveStrictCaller: async () => await harness.service.resolveCaller(request, { strict: true }),
			callerRequest: request,
			isolationApi,
			runtimeApi: { startTaskSession },
		} as unknown as RuntimeTrpcContext);
		return { caller, startTaskSession };
	}

	it("binds through the router and then starts cards in its own project only (enforce)", async () => {
		const harness = setup({ isolation: { mode: "enforce" } });
		const command = router(harness, 300, harness.orchestratorCredential, "a").caller;
		const issued = await command.isolation.issueChildCredential();
		expect(issued).toMatchObject({ ok: true });
		harness.spawnWorker();
		expect(await command.isolation.bindChildCredential({ credential: issued.credential ?? "", pid: 500 })).toEqual({
			ok: true,
			credential: null,
		});
		harness.detach();
		const own = router(harness, 500, issued.credential, "a");
		expect(await own.caller.isolation.whoami()).toMatchObject({
			caller: "session",
			workspaceId: "a",
			role: "orchestrator",
		});
		await own.caller.runtime.startTaskSession({ taskId: "c1", prompt: "", baseRef: "main" } as never);
		expect(own.startTaskSession).toHaveBeenCalledTimes(1);
		const other = router(harness, 500, issued.credential, "b");
		await expect(
			other.caller.runtime.startTaskSession({ taskId: "c1", prompt: "", baseRef: "main" } as never),
		).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("start a task in project b") });
		expect(other.startTaskSession).not.toHaveBeenCalled();
	});

	it("without a bound child credential the detached worker is refused, naming the action and the cause", async () => {
		const harness = setup({ isolation: { mode: "enforce" } });
		harness.spawnWorker();
		harness.detach();
		const detached = router(harness, 500, harness.orchestratorCredential, "a");
		await expect(
			detached.caller.runtime.startTaskSession({ taskId: "c1", prompt: "", baseRef: "main" } as never),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringMatching(/start a task in project a.*run the command in the foreground/su),
		});
	});
});

describe("child credentials can't crowd out other sessions' credentials", () => {
	const session = (index: number): AgentSessionIdentity => ({
		workspaceId: `w${index % 7}`,
		taskId: `t${index}`,
		role: "card",
		agentId: "codex",
		cwd: `/w/t${index}`,
	});

	it("caps unbound child credentials per session, and the service refuses beyond it", async () => {
		const harness = setup();
		const request = requestFrom(300, harness.orchestratorCredential);
		for (let index = 0; index < MAX_UNBOUND_CHILD_CREDENTIALS_PER_SESSION; index += 1) {
			expect(await harness.service.issueChildCredential(request)).toMatchObject({ ok: true });
		}
		expect(await harness.service.issueChildCredential(request)).toMatchObject({ ok: false });
		// Another session's share is its own.
		expect(harness.service.credentials.issueChild(CARD_B)).not.toBeNull();
	});

	it("a card issuing past the cap evicts no other session's credential", async () => {
		const harness = setup();
		const request = requestFrom(300, harness.orchestratorCredential);
		for (let index = 0; index < MAX_SESSION_CREDENTIALS + 50; index += 1) {
			await harness.service.issueChildCredential(request);
		}
		expect((await harness.service.resolveCaller(requestFrom(650, harness.cardCredential))).kind).toBe("session");
		expect(harness.service.credentials.current("a", ORCHESTRATOR_A.taskId)).toBe(harness.orchestratorCredential);
	});

	it("at the global cap child credentials go first, and a child never pushes out a session's own", () => {
		const registry = createSessionCredentialRegistry();
		const owner = session(0);
		registry.issue(owner);
		const own = Array.from({ length: MAX_SESSION_CREDENTIALS - 3 }, (_, index) => registry.issue(session(index + 1)));
		const children = [registry.issueChild(owner), registry.issueChild(owner)];
		expect(children.every((child) => child !== null)).toBe(true);
		// 500 now. A new session evicts the oldest child, not a session.
		const newest = registry.issue(session(MAX_SESSION_CREDENTIALS));
		expect(registry.resolve(children[0])).toBeNull();
		expect(registry.resolve(children[1])).not.toBeNull();
		expect(own.every((credential) => registry.resolve(credential) !== null)).toBe(true);
		expect(registry.resolve(newest)).not.toBeNull();
		// Full of sessions plus one child: a child takes the child's place; with no child left, none is issued.
		expect(registry.issueChild(session(5))).not.toBeNull();
		expect(registry.resolve(children[1])).toBeNull();
		registry.issue(session(MAX_SESSION_CREDENTIALS + 1));
		expect(registry.list().some((entry) => entry.child)).toBe(false);
		expect(registry.issueChild(session(6))).toBeNull();
		expect(own.slice(1).every((credential) => registry.resolve(credential) !== null)).toBe(true);
	});
});

describe("a reused pid is never a bound child", () => {
	it("a credential-less process with the child's old pid is the user, not the session (enforce)", async () => {
		const harness = setup({ isolation: { mode: "enforce" } });
		await issueAndBind(harness);
		harness.detach();
		expect(await harness.service.resolveCaller(requestFrom(500, null))).toMatchObject({
			kind: "session",
			via: "process",
		});
		harness.exitWorker();
		harness.proc.processes.push(processEntry(500, 1, { startTime: "99" }));
		expect(await harness.service.resolveCaller(requestFrom(500, null))).toEqual({ kind: "user" });
	});

	it("prune drops a bound child whose pid now has another start time", async () => {
		const harness = setup();
		const child = await issueAndBind(harness);
		harness.detach();
		await harness.service.pruneCredentials();
		expect(harness.service.credentials.resolve(child)).not.toBeNull();
		harness.exitWorker();
		harness.proc.processes.push(processEntry(500, 1, { startTime: "99" }));
		await harness.service.pruneCredentials();
		expect(harness.service.credentials.resolve(child)).toBeNull();
	});
});
