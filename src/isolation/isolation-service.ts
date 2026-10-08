// The server's isolation state and checks (docs/fork/project-isolation.md): the session credentials, the user's
// grants and their approvals, who a request comes from, and the logged decisions on reaching a workspace or changing
// the project list. One instance per server (runtime-server.ts); the tRPC layer (src/trpc/isolation-api.ts) and the
// launch path (runtime-api.ts startTaskSession) use it.
//
// Who calls:
//   - A credential is only good from its own session's process tree: the server traces the loopback connection to the
//     calling process (/proc) and checks its parent chain against the session's root pid (its PTY child, or the bound
//     pid of a headless run). A credential from anywhere else, or of a session that is no longer live, makes the
//     caller "unknown" (never the user). Without /proc (not Linux) a live session's credential is taken as is.
//   - Agents that run every session's tools in one shared daemon (Cline 3.x, sharesProcessEnvAcrossSessions) carry
//     the first session's credential everywhere: their caller is the session whose PTY tree the call comes from, else
//     (a call from the daemon) the session whose cwd contains the calling process's cwd, read from /proc (never a
//     header), always with the card role. A cwd that matches no session is "unknown".
//   - Without a credential the caller is the user, unless the process lookup (strict, or while some workspace is in
//     enforce) finds a session's tree above it.
import type { IsolationMode, PipelineConfig } from "../config/pipeline-config";
import type { RuntimeAgentId } from "../core/api-contract";
import { isPathInside } from "../guardrails/task-guardrails";
import type { ProcessEntry, ProcessTableReader } from "../server/process-table";
import { isSharedAgentDaemonCommand, sharesProcessEnvAcrossSessions } from "../terminal/agent-guardrails";
import {
	decideProjectChange,
	decideWorkspaceAccess,
	type ProjectChangeKind,
	type WorkspaceAccessDecision,
} from "./access-policy";
import { type ApprovalStore, createApprovalStore } from "./approvals";
import { findPeerProcessPid, isLoopbackConnection, listParentChain, type PeerConnection } from "./caller-process";
import { createIsolationGrantStore, type IsolationGrantStore } from "./grants";
import { appendIsolationLog, type IsolationLogKind, type IsolationLogWriter } from "./isolation-log";
import { isAnyWorkspaceEnforced, readIsolationConfig, resolveIsolationMode } from "./isolation-settings";
import {
	type AgentSessionIdentity,
	type CredentialEntry,
	createSessionCredentialRegistry,
	describeCaller,
	getSessionRole,
	MAX_CHILD_CREDENTIALS_PER_SESSION,
	MAX_UNBOUND_CHILD_CREDENTIALS_PER_SESSION,
	type RuntimeCaller,
	type SessionCredentialRegistry,
	USER_CALLER,
} from "./session-identity";

/** An agent session as the terminal managers know it, for the process-tree lookup. */
export interface LiveAgentSession {
	workspaceId: string;
	taskId: string;
	agentId: RuntimeAgentId | null;
	pid: number | null;
	cwd: string | null;
	/** The session has a process now (TerminalSessionManager.hasLiveProcess). */
	live: boolean;
}

export interface CallerRequest {
	credential: string | null;
	connection: PeerConnection | null;
	/** Socket-like object the process lookup is cached on (one lookup per keep-alive connection). */
	connectionKey: object | null;
}

export interface IsolationServiceDependencies {
	readConfig?: () => Promise<PipelineConfig>;
	/** The /proc reader; null where it isn't supported (no process-tree checks). */
	processReader: ProcessTableReader | null;
	listLiveSessions: () => LiveAgentSession[];
	log?: IsolationLogWriter;
	now?: () => number;
	/** The approval codes' console (approvals.ts); tests capture it. */
	announceApproval?: (line: string) => void;
	warn?: (message: string) => void;
	/** Whether a pid is a running process (bound headless runs); default `process.kill(pid, 0)`. */
	isPidAlive?: (pid: number) => boolean;
}

export interface IsolationService {
	credentials: SessionCredentialRegistry;
	grants: IsolationGrantStore;
	approvals: ApprovalStore;
	readConfig: () => Promise<PipelineConfig>;
	/** Issues a session's credential and drops the ones of sessions that are gone. */
	issueCredential: (identity: AgentSessionIdentity) => string;
	/**
	 * Revokes the credentials of sessions that have ended (the server runs it every few seconds). The dead pids go at
	 * once; the returned promise settles after the /proc check of bound child credentials (a reused pid).
	 */
	pruneCredentials: () => Promise<void>;
	/** Binds a headless run's credential to its pid (the root of its process tree). */
	bindCredential: (credential: string, pid: number) => boolean;
	/**
	 * A child credential for a detached process the calling session is about to spawn (`kanban bench calibrate`):
	 * same workspace, task and role, unusable until `bindChildCredential`. Only a session calling from its own
	 * process tree with its own credential gets one.
	 */
	issueChildCredential: (request: CallerRequest) => Promise<ChildCredentialResult>;
	/**
	 * Binds a child credential to `pid`, which must be a live child of the calling process (its /proc parent), and the
	 * caller the session the credential was issued to. The credential stops working when that process exits.
	 */
	bindChildCredential: (request: CallerRequest, credential: string, pid: number) => Promise<ChildCredentialResult>;
	resolveCaller: (request: CallerRequest, options?: { strict?: boolean }) => Promise<RuntimeCaller>;
	/** The decision on a reach, not logged (listings, whoami). */
	peekWorkspaceAccess: (
		caller: RuntimeCaller,
		toWorkspaceId: string,
		config: PipelineConfig,
	) => WorkspaceAccessDecision;
	/** A reach into `toWorkspaceId`, decided and logged (refused and reported reaches, grant uses). */
	checkWorkspaceAccess: (
		caller: RuntimeCaller,
		toWorkspaceId: string,
		action: string,
		config?: PipelineConfig,
	) => Promise<WorkspaceAccessDecision>;
	/** A project create/add/remove, decided and logged when refused. `target`: the path or project it names. */
	checkProjectChange: (
		caller: RuntimeCaller,
		kind: ProjectChangeKind,
		targetWorkspaceId: string | null,
		action: string,
		target?: string | null,
	) => Promise<{ allowed: true } | { allowed: false; message: string }>;
	log: (
		workspaceIds: readonly (string | null)[],
		record: {
			kind: IsolationLogKind;
			taskId: string | null;
			from: string | null;
			to: string | null;
			action: string;
			detail: string;
		},
	) => Promise<void>;
}

export type ChildCredentialResult = { ok: true; credential: string } | { ok: false; error: string };

const CONFIG_CACHE_MS = 2_000;
const CREDENTIAL_START_GRACE_MS = 60_000;

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
	}
}

function deepestContaining<T extends { cwd: string }>(candidates: readonly T[], cwd: string): T | null {
	return (
		candidates
			.filter((candidate) => candidate.cwd && isPathInside(candidate.cwd, cwd))
			.sort((left, right) => right.cwd.length - left.cwd.length)[0] ?? null
	);
}

/** Every workspace's effective mode (the machine-wide one under `*`), to notice mode changes. */
function describeModes(config: PipelineConfig): Map<string, IsolationMode> {
	const modes = new Map<string, IsolationMode>([["*", config.isolation.mode]]);
	for (const workspaceId of Object.keys(config.workspaces)) {
		modes.set(workspaceId, resolveIsolationMode(config, workspaceId));
	}
	return modes;
}

export function createIsolationService(deps: IsolationServiceDependencies): IsolationService {
	const now = deps.now ?? Date.now;
	const loadConfig = deps.readConfig ?? readIsolationConfig;
	const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
	const credentials = createSessionCredentialRegistry(now);
	const grants = createIsolationGrantStore(now);
	const approvals = createApprovalStore({ now, announce: deps.announceApproval });
	const writeLog = deps.log ?? appendIsolationLog;
	const peerLookups = new WeakMap<object, Promise<{ pid: number; processes: ProcessEntry[] } | null>>();

	const log: IsolationService["log"] = async (workspaceIds, record) => {
		const line = {
			at: new Date(now()).toISOString(),
			kind: record.kind,
			taskId: record.taskId,
			fromWorkspaceId: record.from,
			toWorkspaceId: record.to,
			action: record.action,
			detail: record.detail,
		};
		for (const workspaceId of new Set(workspaceIds.filter((id): id is string => Boolean(id)))) {
			await writeLog(workspaceId, line);
		}
	};

	// Credential-less requests ask whether some workspace is in enforce: read config.json at most every 2 s, and log
	// every isolation mode change seen (Kanban has no command that sets it, so it was an edit of config.json).
	let cachedConfig: { at: number; config: Promise<PipelineConfig> } | null = null;
	let lastModes: Map<string, IsolationMode> | null = null;
	const noteModeChanges = async (config: PipelineConfig) => {
		const modes = describeModes(config);
		const previous = lastModes;
		lastModes = modes;
		if (!previous) {
			return;
		}
		for (const key of new Set([...previous.keys(), ...modes.keys()])) {
			const before = previous.get(key) ?? previous.get("*") ?? "off";
			const after = modes.get(key) ?? modes.get("*") ?? "off";
			if (before === after) {
				continue;
			}
			const target = key === "*" ? "isolation.mode" : `workspaces.${key}.isolation.mode`;
			const detail = `${target}: ${before} → ${after} (config.json changed; by: not known to Kanban)`;
			deps.warn?.(`project isolation: ${detail}`);
			await log(key === "*" ? [...modes.keys()].filter((id) => id !== "*") : [key], {
				kind: "mode_changed",
				taskId: null,
				from: null,
				to: key === "*" ? null : key,
				action: "config",
				detail,
			});
		}
	};
	const readConfig = async (): Promise<PipelineConfig> => {
		if (!cachedConfig || now() - cachedConfig.at >= CONFIG_CACHE_MS) {
			const config = loadConfig();
			cachedConfig = { at: now(), config };
			void config.then(noteModeChanges).catch(() => undefined);
		}
		return await cachedConfig.config;
	};

	/**
	 * The pid at the root of a credential's session tree, or null when the session is no longer live. With
	 * `processes` (a /proc read) a bound process must still have its start time, so a reused pid isn't it.
	 */
	const sessionRootPid = (
		entry: CredentialEntry,
		live: readonly LiveAgentSession[],
		processes?: readonly ProcessEntry[],
	): number | null => {
		if (entry.boundPid !== null) {
			if (!isPidAlive(entry.boundPid)) {
				return null;
			}
			if (processes && entry.boundStartTime !== null) {
				const bound = processes.find((candidate) => candidate.pid === entry.boundPid);
				return bound?.startTime === entry.boundStartTime ? entry.boundPid : null;
			}
			return entry.boundPid;
		}
		if (entry.child) {
			// Not bound yet: it stands for no process at all (never its parent session's tree).
			return null;
		}
		const session = live.find(
			(candidate) =>
				candidate.workspaceId === entry.identity.workspaceId && candidate.taskId === entry.identity.taskId,
		);
		return session?.live && typeof session.pid === "number" && session.pid > 0 ? session.pid : null;
	};

	const pruneCredentials = async () => {
		const live = deps.listLiveSessions();
		// A credential is issued just before its process starts (and a headless run's is bound right after its spawn):
		// until then it has no root and must stay.
		credentials.prune(
			(entry) => sessionRootPid(entry, live) !== null || now() - entry.issuedAt < CREDENTIAL_START_GRACE_MS,
		);
		// A bound child whose pid now has another start time has exited, and its pid was reused.
		const reader = deps.processReader;
		if (!reader) {
			return;
		}
		const stale = new Set<string>();
		for (const entry of credentials.list()) {
			if (!entry.child || entry.boundPid === null || entry.boundStartTime === null) {
				continue;
			}
			const current = await reader.read(entry.boundPid).catch(() => null);
			if (current?.startTime !== entry.boundStartTime) {
				stale.add(`${entry.boundPid}:${entry.boundStartTime}`);
			}
		}
		if (stale.size > 0) {
			credentials.prune((entry) => !(entry.child && stale.has(`${entry.boundPid}:${entry.boundStartTime}`)));
		}
	};

	const issueCredential: IsolationService["issueCredential"] = (identity) => {
		void pruneCredentials().catch(() => undefined);
		return credentials.issue(identity);
	};

	const lookUpPeer = async (request: CallerRequest) => {
		const reader = deps.processReader;
		if (!reader || !request.connection || !isLoopbackConnection(request.connection)) {
			return null;
		}
		const key = request.connectionKey;
		let lookup = key ? peerLookups.get(key) : undefined;
		if (!lookup) {
			lookup = findPeerProcessPid(reader, request.connection).catch(() => null);
			if (key) {
				peerLookups.set(key, lookup);
			}
		}
		return await lookup;
	};

	const unknown = (reason: string): RuntimeCaller => ({ kind: "unknown", reason });

	const resolveSharedDaemonCaller = (
		entry: CredentialEntry,
		chain: readonly number[],
		peer: { pid: number; processes: ProcessEntry[] },
		live: readonly LiveAgentSession[],
	): RuntimeCaller => {
		const agentId = entry.identity.agentId;
		const registered = credentials.list().filter((candidate) => candidate.identity.agentId === agentId);
		// A call from inside one of the agent's PTY trees is that session's.
		for (const pid of chain) {
			const session = registered.find((candidate) => sessionRootPid(candidate, live, peer.processes) === pid);
			if (session) {
				return { kind: "session", session: session.identity, via: "credential" };
			}
		}
		const byPid = new Map(peer.processes.map((process) => [process.pid, process]));
		if (!chain.some((pid) => isSharedAgentDaemonCommand(agentId, byPid.get(pid)?.command ?? ""))) {
			return unknown("credential used outside its session's process tree");
		}
		// From the shared daemon: the session whose cwd holds the calling process's cwd (from /proc), as a card.
		const cwd = byPid.get(peer.pid)?.cwd ?? null;
		const match = cwd
			? deepestContaining(
					registered
						.filter((candidate) => sessionRootPid(candidate, live, peer.processes) !== null)
						.map((candidate) => candidate.identity),
					cwd,
				)
			: null;
		if (!match) {
			return unknown(`a ${agentId} daemon call from ${cwd ?? "an unknown cwd"}, outside every ${agentId} session`);
		}
		return { kind: "session", session: { ...match, role: "card" }, via: "cwd" };
	};

	const resolveCaller: IsolationService["resolveCaller"] = async (request, options = {}) => {
		const live = deps.listLiveSessions();
		if (request.credential?.trim()) {
			const entry = credentials.resolve(request.credential);
			if (!entry) {
				return unknown("not a live session's credential");
			}
			const rootPid = sessionRootPid(entry, live);
			// A child credential is in its own process's env only, never in a shared daemon's.
			const sharedDaemon = !entry.child && sharesProcessEnvAcrossSessions(entry.identity.agentId);
			if (rootPid === null && !sharedDaemon) {
				return unknown("its session has ended");
			}
			if (!deps.processReader) {
				// No /proc here: the credential of a live session is taken as is.
				return { kind: "session", session: entry.identity, via: "credential" };
			}
			const peer = await lookUpPeer(request);
			if (!peer) {
				return unknown("the calling process could not be traced");
			}
			const chain = listParentChain(peer.pid, peer.processes);
			if (sharedDaemon) {
				return resolveSharedDaemonCaller(entry, chain, peer, live);
			}
			const tracedRoot = sessionRootPid(entry, live, peer.processes);
			return tracedRoot !== null && chain.includes(tracedRoot)
				? { kind: "session", session: entry.identity, via: "credential" }
				: unknown("credential used outside its session's process tree");
		}
		if (!request.connection) {
			return USER_CALLER;
		}
		if (!options.strict && !isAnyWorkspaceEnforced(await readConfig())) {
			return USER_CALLER;
		}
		const peer = await lookUpPeer(request);
		if (!peer) {
			return USER_CALLER;
		}
		for (const pid of listParentChain(peer.pid, peer.processes)) {
			const registered = credentials.list().find((entry) => sessionRootPid(entry, live, peer.processes) === pid);
			if (registered) {
				return { kind: "session", session: registered.identity, via: "process" };
			}
			const session = live.find((candidate) => candidate.live && candidate.pid === pid);
			if (session?.agentId) {
				return {
					kind: "session",
					session: {
						workspaceId: session.workspaceId,
						taskId: session.taskId,
						role: getSessionRole(session.taskId),
						agentId: session.agentId,
						cwd: session.cwd ?? "",
					},
					via: "process",
				};
			}
			if (session) {
				// A user's shell terminal: what runs in it is the user's.
				return USER_CALLER;
			}
		}
		return USER_CALLER;
	};

	/** The session calling from its own tree with its own (not a child) credential, and the calling process. */
	const resolveCredentialOwner = async (
		request: CallerRequest,
	): Promise<{ ok: true; session: AgentSessionIdentity; peerPid: number } | { ok: false; error: string }> => {
		if (!deps.processReader) {
			return { ok: false, error: "the server can't check process trees here (no /proc)" };
		}
		const entry = credentials.resolve(request.credential);
		if (!entry) {
			return { ok: false, error: "only an agent session with its own credential can ask for one" };
		}
		if (entry.child) {
			return { ok: false, error: "a child credential can't hand out further ones" };
		}
		const caller = await resolveCaller(request);
		if (caller.kind !== "session" || caller.via !== "credential") {
			return {
				ok: false,
				error: `the caller is ${caller.kind === "session" ? `card ${caller.session.taskId} by its cwd` : describeCaller(caller)}, not a session calling from its own process tree`,
			};
		}
		const peer = await lookUpPeer(request);
		if (!peer) {
			return { ok: false, error: "the calling process could not be traced" };
		}
		return { ok: true, session: caller.session, peerPid: peer.pid };
	};

	const issueChildCredential: IsolationService["issueChildCredential"] = async (request) => {
		const owner = await resolveCredentialOwner(request);
		if (!owner.ok) {
			return owner;
		}
		await pruneCredentials();
		const credential = credentials.issueChild(owner.session);
		if (!credential) {
			return {
				ok: false,
				error: `the session already holds its ${MAX_UNBOUND_CHILD_CREDENTIALS_PER_SESSION} unbound (or ${MAX_CHILD_CREDENTIALS_PER_SESSION}) child credentials, or the server has no room for another`,
			};
		}
		return { ok: true, credential };
	};

	const bindChildCredential: IsolationService["bindChildCredential"] = async (request, credential, pid) => {
		const owner = await resolveCredentialOwner(request);
		if (!owner.ok) {
			return owner;
		}
		const child = credentials.resolve(credential);
		if (
			!child?.child ||
			child.identity.workspaceId !== owner.session.workspaceId ||
			child.identity.taskId !== owner.session.taskId
		) {
			return { ok: false, error: "not a child credential of the calling session" };
		}
		if (child.boundPid !== null) {
			return { ok: false, error: "that child credential is already bound" };
		}
		// Read at bind time: the process must be the caller's own child, alive (not a zombie).
		const target = deps.processReader ? await deps.processReader.read(pid).catch(() => null) : null;
		if (!target || target.state === "Z" || target.ppid !== owner.peerPid) {
			return { ok: false, error: `process ${pid} is not a live child of the calling process` };
		}
		if (!credentials.bindChild(credential, pid, target.startTime)) {
			return { ok: false, error: "the child credential could not be bound" };
		}
		await log([owner.session.workspaceId], {
			kind: "child_credential",
			taskId: owner.session.taskId,
			from: owner.session.workspaceId,
			to: owner.session.workspaceId,
			action: "isolation.bindChildCredential",
			detail: `bound to pid ${pid} (child of ${owner.peerPid})`,
		});
		return { ok: true, credential };
	};

	const decideAccess = (
		caller: RuntimeCaller,
		toWorkspaceId: string,
		config: PipelineConfig,
		action?: string,
	): WorkspaceAccessDecision =>
		caller.kind === "user" || (caller.kind === "session" && caller.session.workspaceId === toWorkspaceId)
			? { outcome: "allow", mode: "off" }
			: decideWorkspaceAccess({
					config,
					caller,
					toWorkspaceId,
					grant: caller.kind === "session" ? grants.find(caller.session, toWorkspaceId) : null,
					action,
				});
	const peekWorkspaceAccess: IsolationService["peekWorkspaceAccess"] = (caller, toWorkspaceId, config) =>
		decideAccess(caller, toWorkspaceId, config);

	const checkWorkspaceAccess: IsolationService["checkWorkspaceAccess"] = async (
		caller,
		toWorkspaceId,
		action,
		config,
	) => {
		if (caller.kind === "user" || (caller.kind === "session" && caller.session.workspaceId === toWorkspaceId)) {
			return { outcome: "allow", mode: "off" };
		}
		const decision = decideAccess(caller, toWorkspaceId, config ?? (await readConfig()), action);
		const base =
			caller.kind === "session"
				? { taskId: caller.session.taskId, from: caller.session.workspaceId, to: toWorkspaceId, action }
				: { taskId: null, from: null, to: toWorkspaceId, action };
		const via = caller.kind === "session" ? `via ${caller.via}` : caller.reason;
		if (decision.outcome === "refuse" || decision.outcome === "report") {
			await log([caller.kind === "session" ? caller.session.workspaceId : toWorkspaceId], {
				...base,
				kind: decision.outcome === "refuse" ? "refused" : "reported",
				detail: via,
			});
		} else if (decision.grant && caller.kind === "session") {
			await log([caller.session.workspaceId, toWorkspaceId], {
				...base,
				kind: "grant_used",
				detail: `grant ${decision.grant.id} (${decision.grant.reason})`,
			});
		}
		return decision;
	};

	const checkProjectChange: IsolationService["checkProjectChange"] = async (
		caller,
		kind,
		targetWorkspaceId,
		action,
		target,
	) => {
		const decision = decideProjectChange({ caller, kind, targetWorkspaceId, target });
		if (!decision.allowed && caller.kind !== "user") {
			await log([caller.kind === "session" ? caller.session.workspaceId : null, targetWorkspaceId], {
				kind: "project_change_refused",
				taskId: caller.kind === "session" ? caller.session.taskId : null,
				from: caller.kind === "session" ? caller.session.workspaceId : null,
				to: targetWorkspaceId,
				action,
				detail: `${kind} refused (${caller.kind === "session" ? `via ${caller.via}` : caller.reason})`,
			});
		}
		return decision;
	};

	return {
		credentials,
		grants,
		approvals,
		readConfig,
		issueCredential,
		pruneCredentials,
		bindCredential: (credential, pid) => credentials.bindPid(credential, pid),
		issueChildCredential,
		bindChildCredential,
		resolveCaller,
		peekWorkspaceAccess,
		checkWorkspaceAccess,
		checkProjectChange,
		log,
	};
}
