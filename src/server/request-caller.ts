// Who an HTTP or WebSocket request to the runtime comes from (project isolation, src/isolation/isolation-service.ts):
// the session credential header plus the loopback connection the server traces to the calling process. The tRPC
// context resolves the caller lazily (hooks.ingest, the hot path, never needs it), and a session's call without a
// workspace is scoped to its own project instead of the server's active one.
import type { IncomingMessage } from "node:http";

import type { CallerRequest, IsolationService } from "../isolation/isolation-service";
import { KANBAN_SESSION_CREDENTIAL_HEADER, type RuntimeCaller } from "../isolation/session-identity";

export function readRequestHeader(request: IncomingMessage, name: string): string | null {
	const value = request.headers[name];
	const first = Array.isArray(value) ? value[0] : value;
	return typeof first === "string" && first.trim() ? first.trim() : null;
}

/** The request as the isolation service's caller lookup takes it: credential header and loopback connection. */
export function buildCallerRequest(request: IncomingMessage): CallerRequest {
	return {
		credential: readRequestHeader(request, KANBAN_SESSION_CREDENTIAL_HEADER),
		connection: {
			remoteAddress: request.socket.remoteAddress,
			remotePort: request.socket.remotePort,
			localPort: request.socket.localPort,
		},
		connectionKey: request.socket,
	};
}

export interface RequestCallerScope {
	getCaller: () => Promise<RuntimeCaller>;
	resolveStrictCaller: () => Promise<RuntimeCaller>;
	/** The session's own workspace when the request names none (only requests with a credential). */
	fallbackWorkspaceId: string | null;
}

export interface RequestCallerResolver {
	resolveRequestCaller: (request: IncomingMessage, strict?: boolean) => Promise<RuntimeCaller>;
	resolveRequestScope: (request: IncomingMessage) => Promise<RequestCallerScope>;
	/** Whether a WebSocket upgrade for `workspaceId` may go ahead (a session only watches its own project). */
	authorizeWorkspaceUpgrade: (request: IncomingMessage, workspaceId: string | null) => Promise<boolean>;
}

export function createRequestCallerResolver(isolation: IsolationService): RequestCallerResolver {
	const resolveRequestCaller: RequestCallerResolver["resolveRequestCaller"] = async (request, strict = false) =>
		await isolation
			.resolveCaller(buildCallerRequest(request), { strict })
			// A lookup that fails is the user's request, as before isolation (config errors never lock the user out),
			// except for the strict lookups of grants, approvals and project changes.
			.catch(
				(): RuntimeCaller => (strict ? { kind: "unknown", reason: "the caller lookup failed" } : { kind: "user" }),
			);

	return {
		resolveRequestCaller,
		resolveRequestScope: async (request) => {
			let lookup: Promise<RuntimeCaller> | null = null;
			const getCaller = async () => {
				lookup ??= resolveRequestCaller(request);
				return await lookup;
			};
			// Only a request with a credential can be a session without the process lookup, so only those resolve here.
			const fallbackWorkspaceId = readRequestHeader(request, KANBAN_SESSION_CREDENTIAL_HEADER)
				? await getCaller().then((caller) => (caller.kind === "session" ? caller.session.workspaceId : null))
				: null;
			return {
				getCaller,
				resolveStrictCaller: async () => await resolveRequestCaller(request, true),
				fallbackWorkspaceId,
			};
		},
		authorizeWorkspaceUpgrade: async (request, workspaceId) => {
			const caller = await resolveRequestCaller(request);
			if (caller.kind === "user" || !workspaceId) {
				return true;
			}
			const decision = await isolation.checkWorkspaceAccess(caller, workspaceId, "websocket");
			return decision.outcome !== "refuse";
		},
	};
}
