// The runtime's request → caller step (src/server/request-caller.ts), which the tRPC context and the WebSocket
// upgrades use: the credential header names the session, a session's call without a workspace falls back to its own
// project, and the caller is only resolved when something asks.
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { createIsolationService } from "../../../src/isolation/isolation-service";
import { KANBAN_SESSION_CREDENTIAL_HEADER } from "../../../src/isolation/session-identity";
import { createRequestCallerResolver } from "../../../src/server/request-caller";

function fakeRequest(headers: Record<string, string> = {}): IncomingMessage {
	return {
		headers,
		socket: { remoteAddress: "127.0.0.1", remotePort: 40000, localPort: 3484 },
	} as unknown as IncomingMessage;
}

function setup() {
	const isolation = createIsolationService({
		readConfig: async () => parsePipelineConfig({ isolation: { mode: "enforce" } }).config,
		processReader: null,
		listLiveSessions: () => [
			{ workspaceId: "a", taskId: "t1", agentId: "claude", pid: 4242, cwd: "/w/t1", live: true },
		],
		log: async () => {},
	});
	const credential = isolation.credentials.issue({
		workspaceId: "a",
		taskId: "t1",
		role: "card",
		agentId: "claude",
		cwd: "/w/t1",
	});
	return { isolation, credential, resolver: createRequestCallerResolver(isolation) };
}

describe("request caller", () => {
	it("maps the credential header to its session, and scopes a call without a workspace to the session's own", async () => {
		const { credential, resolver } = setup();
		const scope = await resolver.resolveRequestScope(fakeRequest({ [KANBAN_SESSION_CREDENTIAL_HEADER]: credential }));
		expect(scope.fallbackWorkspaceId).toBe("a");
		expect(await scope.getCaller()).toMatchObject({
			kind: "session",
			session: { workspaceId: "a", taskId: "t1" },
			via: "credential",
		});
	});

	it("a request without a credential is the user's and resolves nothing until asked", async () => {
		const { isolation, resolver } = setup();
		const resolveCaller = vi.spyOn(isolation, "resolveCaller");
		const scope = await resolver.resolveRequestScope(fakeRequest());
		expect(scope.fallbackWorkspaceId).toBeNull();
		expect(resolveCaller).not.toHaveBeenCalled();
		expect(await scope.getCaller()).toEqual({ kind: "user" });
	});

	it("a forged credential is an unknown caller with no fallback workspace", async () => {
		const { resolver } = setup();
		const scope = await resolver.resolveRequestScope(fakeRequest({ [KANBAN_SESSION_CREDENTIAL_HEADER]: "forged" }));
		expect(scope.fallbackWorkspaceId).toBeNull();
		expect((await scope.getCaller()).kind).toBe("unknown");
		expect(
			await resolver.authorizeWorkspaceUpgrade(fakeRequest({ [KANBAN_SESSION_CREDENTIAL_HEADER]: "forged" }), "b"),
		).toBe(false);
	});

	it("refuses a session's WebSocket upgrade into another project under enforce", async () => {
		const { credential, resolver } = setup();
		const request = fakeRequest({ [KANBAN_SESSION_CREDENTIAL_HEADER]: credential });
		expect(await resolver.authorizeWorkspaceUpgrade(request, "b")).toBe(false);
		expect(await resolver.authorizeWorkspaceUpgrade(request, "a")).toBe(true);
		expect(await resolver.authorizeWorkspaceUpgrade(fakeRequest(), "b")).toBe(true);
	});
});
