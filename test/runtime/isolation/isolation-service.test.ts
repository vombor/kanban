// The server's isolation state (src/isolation/isolation-service.ts): credentials bound to their session's process
// tree, the Cline daemon's cwd rule, the process-tree lookup for calls without a credential, revocation, and the logged
// decisions.
import { describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { findPeerProcessPid, findSessionAncestor } from "../../../src/isolation/caller-process";
import type { IsolationLogRecord } from "../../../src/isolation/isolation-log";
import { createIsolationService, type LiveAgentSession } from "../../../src/isolation/isolation-service";
import type { AgentSessionIdentity } from "../../../src/isolation/session-identity";
import type { ProcessEntry, ProcessTableReader } from "../../../src/server/process-table";

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

// The server (pid 10) listens on 3484 (0x0D9C); the calling process `callerPid` connected from 40000 (0x9C40).
const DEFAULT_TREE = [processEntry(10, 1), processEntry(200, 10), processEntry(250, 200), processEntry(300, 250)];

function fakeReader(processes: ProcessEntry[] = DEFAULT_TREE, callerPid = 300): ProcessTableReader {
	return {
		list: async () => processes,
		read: async () => null,
		readSocketInodes: async (pid) => (pid === callerPid ? ["777"] : []),
		readNetSockets: async () => ({
			tcp: [
				{ inode: "777", local: "0100007F:9C40", remote: "0100007F:0D9C", state: "01" },
				{ inode: "778", local: "0100007F:0D9C", remote: "0100007F:9C40", state: "01" },
			],
			unix: [],
		}),
	};
}

const CONNECTION = { remoteAddress: "127.0.0.1", remotePort: 40000, localPort: 3484 };

function setup(
	options: {
		raw?: Record<string, unknown>;
		sessions?: LiveAgentSession[];
		reader?: ProcessTableReader | null;
		alivePids?: number[];
		now?: () => number;
	} = {},
) {
	const log = vi.fn(async (_workspaceId: string, _record: IsolationLogRecord) => {});
	let raw = options.raw ?? {};
	const sessions = options.sessions ?? [];
	const service = createIsolationService({
		readConfig: async () => parsePipelineConfig(raw).config,
		processReader: options.reader === undefined ? fakeReader() : options.reader,
		listLiveSessions: () => sessions,
		log,
		now: options.now,
		isPidAlive: (pid) => (options.alivePids ?? []).includes(pid),
		announceApproval: () => {},
	});
	return {
		service,
		log,
		sessions,
		setRaw: (next: Record<string, unknown>) => {
			raw = next;
		},
	};
}

function liveSession(overrides: Partial<LiveAgentSession> = {}): LiveAgentSession {
	return { workspaceId: "a", taskId: "t1", agentId: "codex", pid: 200, cwd: "/w/t1", live: true, ...overrides };
}

const CARD: AgentSessionIdentity = { workspaceId: "a", taskId: "t1", role: "card", agentId: "codex", cwd: "/w/t1" };

describe("caller-process", () => {
	it("finds the process holding the client end of a loopback connection, and the session above it", async () => {
		const peer = await findPeerProcessPid(fakeReader(), CONNECTION, 10);
		expect(peer?.pid).toBe(300);
		expect(findSessionAncestor(300, peer?.processes ?? [], new Set([200]))).toBe(200);
		expect(findSessionAncestor(300, peer?.processes ?? [], new Set([999]))).toBeNull();
		expect(await findPeerProcessPid(fakeReader(), { ...CONNECTION, remoteAddress: "10.0.0.5" }, 10)).toBeNull();
	});
});

describe("isolation service credentials", () => {
	const request = (credential: string | null) => ({ credential, connection: CONNECTION, connectionKey: null });

	it("takes a credential only from its own session's process tree", async () => {
		const { service } = setup({ sessions: [liveSession()] });
		const credential = service.credentials.issue(CARD);
		expect(await service.resolveCaller(request(credential))).toMatchObject({
			kind: "session",
			session: { workspaceId: "a", taskId: "t1" },
			via: "credential",
		});
		// The same credential from a process outside the session's PTY tree (copied into another shell).
		const elsewhere = setup({
			sessions: [liveSession()],
			reader: fakeReader([processEntry(10, 1), processEntry(200, 10), processEntry(400, 1), processEntry(300, 400)]),
		});
		const copied = elsewhere.service.credentials.issue(CARD);
		expect(await elsewhere.service.resolveCaller(request(copied))).toMatchObject({ kind: "unknown" });
	});

	it("a forged or replaced credential is an unknown caller, never the user", async () => {
		const { service } = setup({ sessions: [liveSession()] });
		const first = service.credentials.issue(CARD);
		const second = service.credentials.issue(CARD);
		expect(await service.resolveCaller(request(first))).toMatchObject({ kind: "unknown" });
		expect((await service.resolveCaller(request(second))).kind).toBe("session");
		expect(await service.resolveCaller(request("forged"))).toMatchObject({ kind: "unknown" });
	});

	it("revokes the credential of a session that ended", async () => {
		let now = 1_000_000;
		const { service, sessions } = setup({ sessions: [liveSession()], now: () => now });
		const credential = service.credentials.issue(CARD);
		sessions[0] = liveSession({ live: false });
		expect(await service.resolveCaller(request(credential))).toMatchObject({
			kind: "unknown",
			reason: "its session has ended",
		});
		now += 61_000;
		service.pruneCredentials();
		expect(service.credentials.resolve(credential)).toBeNull();
	});

	it("binds a headless run's credential to its pid", async () => {
		const orchestrator: AgentSessionIdentity = {
			workspaceId: "a",
			taskId: "__home_agent__:a:claude",
			role: "orchestrator",
			agentId: "claude",
			cwd: "/w",
		};
		const { service } = setup({ alivePids: [250] });
		const credential = service.issueCredential(orchestrator);
		expect(await service.resolveCaller(request(credential))).toMatchObject({ kind: "unknown" });
		expect(service.bindCredential(credential, 250)).toBe(true);
		expect(await service.resolveCaller(request(credential))).toMatchObject({
			kind: "session",
			session: { role: "orchestrator", workspaceId: "a" },
		});
	});

	it("without /proc takes a live session's credential as is", async () => {
		const { service } = setup({ sessions: [liveSession()], reader: null });
		const credential = service.credentials.issue(CARD);
		expect((await service.resolveCaller(request(credential))).kind).toBe("session");
	});
});

describe("isolation service: Cline's shared hub daemon", () => {
	// Cline's daemon (pid 500, started by the first card's PTY 200 and reparented to init) runs every card's tools
	// with the first card's env; the calling process 300 is its child.
	const daemonTree = (callerCwd: string | null) => [
		processEntry(10, 1),
		processEntry(200, 10),
		processEntry(210, 10),
		processEntry(500, 1, { command: "node cline --cline-hub-daemon" }),
		processEntry(300, 500, { cwd: callerCwd }),
	];
	const clineSessions = () => [
		liveSession({ taskId: "t1", agentId: "cline", pid: 200, cwd: "/w/t1" }),
		liveSession({ workspaceId: "b", taskId: "t2", agentId: "cline", pid: 210, cwd: "/w/t2" }),
	];
	const issueBoth = (service: ReturnType<typeof setup>["service"]) => {
		const first = service.credentials.issue({ ...CARD, agentId: "cline" });
		service.credentials.issue({ workspaceId: "b", taskId: "t2", role: "card", agentId: "cline", cwd: "/w/t2" });
		service.credentials.issue({
			workspaceId: "a",
			taskId: "__home_agent__:a:cline",
			role: "orchestrator",
			agentId: "cline",
			cwd: "/w",
		});
		return first;
	};

	it("attributes a daemon call to the card whose cwd holds the calling process's /proc cwd", async () => {
		const { service } = setup({ sessions: clineSessions(), reader: fakeReader(daemonTree("/w/t2/src")) });
		const first = issueBoth(service);
		expect(await service.resolveCaller(request(first))).toMatchObject({
			kind: "session",
			session: { workspaceId: "b", taskId: "t2", role: "card" },
			via: "cwd",
		});
	});

	it("never promotes a daemon call to the orchestrator, even from the project root", async () => {
		const sessions = [
			...clineSessions(),
			liveSession({ taskId: "__home_agent__:a:cline", agentId: "cline", pid: 220, cwd: "/w" }),
		];
		const { service } = setup({ sessions, reader: fakeReader(daemonTree("/w/other")) });
		const first = issueBoth(service);
		const caller = await service.resolveCaller(request(first));
		expect(caller).toMatchObject({ kind: "session", session: { role: "card" } });
	});

	it("an unmatched cwd, or a call from outside the daemon, is unknown", async () => {
		const unmatched = setup({ sessions: clineSessions(), reader: fakeReader(daemonTree("/elsewhere")) });
		expect(await unmatched.service.resolveCaller(request(issueBoth(unmatched.service)))).toMatchObject({
			kind: "unknown",
		});
		const noCwd = setup({ sessions: clineSessions(), reader: fakeReader(daemonTree(null)) });
		expect(await noCwd.service.resolveCaller(request(issueBoth(noCwd.service)))).toMatchObject({ kind: "unknown" });
		const outside = setup({
			sessions: clineSessions(),
			reader: fakeReader([processEntry(10, 1), processEntry(300, 1, { cwd: "/w/t2" })]),
		});
		expect(await outside.service.resolveCaller(request(issueBoth(outside.service)))).toMatchObject({
			kind: "unknown",
		});
	});

	function request(credential: string) {
		return { credential, connection: CONNECTION, connectionKey: null };
	}
});

describe("isolation service: calls without a credential", () => {
	const request = { credential: null, connection: CONNECTION, connectionKey: null };

	it("traces a call to a session's process tree, but only under enforce or when strict", async () => {
		const off = setup({ sessions: [liveSession()] });
		expect(await off.service.resolveCaller(request)).toEqual({ kind: "user" });
		expect(await off.service.resolveCaller(request, { strict: true })).toMatchObject({
			kind: "session",
			session: { workspaceId: "a", taskId: "t1", role: "card" },
			via: "process",
		});
		const enforce = setup({ raw: { isolation: { mode: "enforce" } }, sessions: [liveSession()] });
		expect((await enforce.service.resolveCaller(request)).kind).toBe("session");
	});

	it("a process reparented away from its session reads as the user (the reason grants need the console code)", async () => {
		const { service } = setup({
			sessions: [liveSession()],
			reader: fakeReader([processEntry(10, 1), processEntry(200, 10), processEntry(300, 1)]),
		});
		expect(await service.resolveCaller(request, { strict: true })).toEqual({ kind: "user" });
		const approval = service.approvals.request({ kind: "grant", summary: "x", run: async () => "done" });
		expect((await service.approvals.approve(approval.id, "WRONGCODE")).ok).toBe(false);
	});

	it("a user's shell terminal (no agent) is the user", async () => {
		const { service } = setup({
			raw: { isolation: { mode: "enforce" } },
			sessions: [liveSession({ agentId: null, taskId: "__detail_terminal__:t1" })],
		});
		expect(await service.resolveCaller(request)).toEqual({ kind: "user" });
	});
});

describe("isolation service decisions", () => {
	it("logs a refused reach on the session's side and a grant use on both", async () => {
		const { service, log } = setup({ raw: { isolation: { mode: "enforce" } } });
		const session = { workspaceId: "a", taskId: "t1", role: "card" as const, agentId: "claude" as const, cwd: "/w" };
		const caller = { kind: "session" as const, session, via: "credential" as const };
		expect((await service.checkWorkspaceAccess(caller, "b", "workspace.getState")).outcome).toBe("refuse");
		expect(log).toHaveBeenCalledWith("a", expect.objectContaining({ kind: "refused", toWorkspaceId: "b" }));
		service.grants.add({ workspaceId: "a", session: "t1", reach: ["b"], reason: "one-off", minutes: 5 });
		expect((await service.checkWorkspaceAccess(caller, "b", "workspace.getState")).outcome).toBe("allow");
		expect(log).toHaveBeenCalledWith("b", expect.objectContaining({ kind: "grant_used" }));
	});

	it("logs every isolation mode change it sees, old → new", async () => {
		let now = 0;
		const { service, log, setRaw } = setup({
			raw: { workspaces: { a: { isolation: { mode: "report" } } } },
			now: () => now,
		});
		await service.readConfig();
		setRaw({ workspaces: { a: { isolation: { mode: "enforce" } } } });
		now += 5_000;
		await service.readConfig();
		await vi.waitFor(() =>
			expect(log).toHaveBeenCalledWith(
				"a",
				expect.objectContaining({ kind: "mode_changed", detail: expect.stringContaining("report → enforce") }),
			),
		);
	});
});
