// How an agent session proves which workspace it belongs to (docs/fork/project-isolation.md).
//
// Every agent launch through `runtime.startTaskSession` (task cards and the orchestrator's sidebar session, the
// watchdog's start of it included) gets a fresh random credential in its env. The server keeps credential → session
// in memory only (a restart issues new ones on the next launch), and the Kanban CLI sends it back on every runtime
// call (runtime-trpc-client.ts). A request without one is the user's (the browser, the user's own shell), except
// where the server can trace the calling process to a session's process tree (caller-process.ts).
//
// The env name avoids KEY, SECRET and TOKEN: Codex 0.160 drops env vars matching `*KEY*`, `*SECRET*` and `*TOKEN*`
// from its shell tool by default (shell_environment_policy, checked in the installed binary on 2026-10-07).
import { randomBytes, timingSafeEqual } from "node:crypto";

import type { RuntimeAgentId } from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";

export const KANBAN_SESSION_CREDENTIAL_ENV = "KANBAN_SESSION_CREDENTIAL";
/** Informational only (never trusted by the server): lets the CLI scope itself when the runtime is unreachable. */
export const KANBAN_SESSION_WORKSPACE_ENV = "KANBAN_SESSION_WORKSPACE_ID";
export const KANBAN_SESSION_CREDENTIAL_HEADER = "x-kanban-session-credential";

export type AgentSessionRole = "orchestrator" | "card";

export interface AgentSessionIdentity {
	workspaceId: string;
	taskId: string;
	role: AgentSessionRole;
	agentId: RuntimeAgentId;
	/** The session's cwd (the card's worktree, the project checkout for the orchestrator). */
	cwd: string;
}

/**
 * Who is calling the runtime: the user, an agent session (and how that was established), or a caller that presented
 * a session credential the server can't stand behind (revoked, or used outside its session's process tree). An
 * unknown caller is never the user: the always-on rules refuse it, and so does every reach under report/enforce.
 */
export type RuntimeCaller =
	| { kind: "user" }
	| { kind: "session"; session: AgentSessionIdentity; via: "credential" | "cwd" | "process" }
	| { kind: "unknown"; reason: string };

export const USER_CALLER: RuntimeCaller = { kind: "user" };

export function getSessionRole(taskId: string): AgentSessionRole {
	return isHomeAgentSessionId(taskId) ? "orchestrator" : "card";
}

export function describeCaller(caller: RuntimeCaller): string {
	if (caller.kind === "user") {
		return "the user";
	}
	if (caller.kind === "unknown") {
		return `an unidentified agent session (${caller.reason})`;
	}
	return `${caller.session.role === "orchestrator" ? "the orchestrator" : `card ${caller.session.taskId}`} of ${caller.session.workspaceId}`;
}

export interface CredentialEntry {
	identity: AgentSessionIdentity;
	/**
	 * The root of the session's process tree when it isn't a Kanban PTY session (a headless orchestrator run, bound
	 * after it was spawned). PTY sessions are found by their summary's pid.
	 */
	boundPid: number | null;
	issuedAt: number;
}

export interface SessionCredentialRegistry {
	/** A new credential for the session; the session's earlier credential stops working. */
	issue: (identity: AgentSessionIdentity) => string;
	/** The session's current credential (a reused live session keeps it), or null. */
	current: (workspaceId: string, taskId: string) => string | null;
	/** Binds a credential to the root pid of its process tree (headless runs). */
	bindPid: (credential: string, pid: number) => boolean;
	resolve: (credential: string | null | undefined) => CredentialEntry | null;
	/** Every session that has a credential, for the cwd and process lookups. */
	list: () => CredentialEntry[];
	/** Drops the credentials of sessions that are no longer live (called at each issue). */
	prune: (isLive: (entry: CredentialEntry) => boolean) => void;
}

/** At most this many credentials are kept; the oldest go first. */
export const MAX_SESSION_CREDENTIALS = 500;

function sessionKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}\u0000${taskId}`;
}

function sameCredential(left: string, right: string): boolean {
	const a = Buffer.from(left, "utf8");
	const b = Buffer.from(right, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}

export function createSessionCredentialRegistry(now: () => number = Date.now): SessionCredentialRegistry {
	const bySession = new Map<string, { credential: string; entry: CredentialEntry }>();
	const copy = (entry: CredentialEntry): CredentialEntry => ({ ...entry, identity: { ...entry.identity } });
	const find = (credential: string) => {
		for (const value of bySession.values()) {
			if (sameCredential(value.credential, credential)) {
				return value;
			}
		}
		return null;
	};
	return {
		issue: (identity) => {
			const credential = randomBytes(32).toString("hex");
			const key = sessionKey(identity.workspaceId, identity.taskId);
			bySession.delete(key);
			bySession.set(key, { credential, entry: { identity: { ...identity }, boundPid: null, issuedAt: now() } });
			// Map order is insertion order: the first keys are the oldest.
			while (bySession.size > MAX_SESSION_CREDENTIALS) {
				const oldest = bySession.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				bySession.delete(oldest);
			}
			return credential;
		},
		current: (workspaceId, taskId) => bySession.get(sessionKey(workspaceId, taskId))?.credential ?? null,
		bindPid: (credential, pid) => {
			const value = find(credential);
			if (!value || !Number.isInteger(pid) || pid <= 1) {
				return false;
			}
			value.entry.boundPid = pid;
			return true;
		},
		resolve: (credential) => {
			const value = credential?.trim();
			const found = value ? find(value) : null;
			return found ? copy(found.entry) : null;
		},
		list: () => [...bySession.values()].map((value) => copy(value.entry)),
		prune: (isLive) => {
			for (const [key, value] of bySession) {
				if (!isLive(copy(value.entry))) {
					bySession.delete(key);
				}
			}
		},
	};
}
