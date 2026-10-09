import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { getKanbanRuntimePort } from "../../../src/core/runtime-endpoint";
import { handleHttpRequest } from "../../../src/server/middleware";
import {
	createShortcutPortProxyHandler,
	createShortcutPortRegistry,
	parseShortcutPortProxyPath,
	rewriteProxiedLocation,
	SHORTCUT_PROXY_SANDBOX_CSP,
} from "../../../src/server/shortcut-ports";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
	return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
		(resolve, reject) => {
			const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
			});
			req.on("error", reject);
			req.end();
		},
	);
}

describe("shortcut port registry", () => {
	it("never hands out a port twice and forgets ports after 24 h", async () => {
		const osPorts = [41000, 41000, 41001];
		let now = 0;
		const registry = createShortcutPortRegistry({ askOs: async () => osPorts.shift() ?? 0, now: () => now });
		const first = await registry.allocate({ workspaceId: "foo", taskId: "d1111", label: "Preview" });
		const second = await registry.allocate({ workspaceId: "foo", taskId: "d2222", label: "Preview" });
		expect([first.port, second.port]).toEqual([41000, 41001]);
		expect(registry.find(41000)).toMatchObject({ taskId: "d1111" });
		expect(registry.find(42000)).toBeNull();
		now = 24 * 60 * 60_000;
		expect(registry.find(41000)).toBeNull();
	});

	it("parses proxy paths and keeps redirects under the prefix", () => {
		expect(parseShortcutPortProxyPath("/api/shortcut-port/41000/health?x=1")).toEqual({
			port: 41000,
			upstreamPath: "/health?x=1",
		});
		expect(parseShortcutPortProxyPath("/api/shortcut-port/41000")).toEqual({ port: 41000, upstreamPath: null });
		expect(parseShortcutPortProxyPath("/api/shortcut-port/99999/")).toBeNull();
		const input = { port: 41000, basePath: "/api/shortcut-port/41000/" };
		expect(rewriteProxiedLocation("/login", input)).toBe("/api/shortcut-port/41000/login");
		expect(rewriteProxiedLocation("http://localhost:41000/a", input)).toBe("/api/shortcut-port/41000/a");
		expect(rewriteProxiedLocation("https://example.com/", input)).toBe("https://example.com/");
	});
});

describe("shortcut port proxy", () => {
	it("serves only handed-out ports, sandboxed, without Kanban's cookie or the app's Set-Cookie", async () => {
		let seen: IncomingMessage["headers"] | null = null;
		const appPort = await listen((req, res) => {
			seen = req.headers;
			res.writeHead(req.url === "/old" ? 302 : 200, {
				"Set-Cookie": "kanban_session=evil",
				...(req.url === "/old" ? { Location: "/new" } : {}),
				"Content-Type": "text/plain",
			});
			res.end(`app saw ${req.url}`);
		});
		const otherPort = await listen((_req, res) => res.end("not handed out"));
		const registry = createShortcutPortRegistry({ askOs: async () => appPort });
		await registry.allocate({ workspaceId: "foo", taskId: null, label: "Preview" });
		const handler = createShortcutPortProxyHandler({ ports: registry, tls: false });
		const kanbanPort = await listen((req, res) => void handler(req, res));

		const ok = await get(kanbanPort, `/api/shortcut-port/${appPort}/health?x=1`, {
			cookie: "kanban_session=secret",
			authorization: "Bearer secret",
		});
		expect(ok.status).toBe(200);
		expect(ok.body).toBe("app saw /health?x=1");
		expect(ok.headers["content-security-policy"]).toBe(SHORTCUT_PROXY_SANDBOX_CSP);
		expect(ok.headers["set-cookie"]).toBeUndefined();
		expect(seen).not.toHaveProperty("cookie");
		expect(seen).not.toHaveProperty("authorization");
		expect(seen?.["x-forwarded-prefix"]).toBe(`/api/shortcut-port/${appPort}`);

		const redirect = await get(kanbanPort, `/api/shortcut-port/${appPort}/old`);
		expect(redirect.headers.location).toBe(`/api/shortcut-port/${appPort}/new`);
		const slash = await get(kanbanPort, `/api/shortcut-port/${appPort}?a=b`);
		expect([slash.status, slash.headers.location]).toEqual([308, `/api/shortcut-port/${appPort}/?a=b`]);
		expect((await get(kanbanPort, `/api/shortcut-port/${otherPort}/`)).status).toBe(404);
	});

	it("answers a reloading page while nothing listens on the port yet", async () => {
		const registry = createShortcutPortRegistry({ askOs: async () => 41999 });
		await registry.allocate({ workspaceId: "foo", taskId: null, label: "Preview" });
		const handler = createShortcutPortProxyHandler({ ports: registry, tls: false, findHost: async () => null });
		const kanbanPort = await listen((req, res) => void handler(req, res));
		const response = await get(kanbanPort, "/api/shortcut-port/41999/");
		expect(response.status).toBe(503);
		expect(response.body).toContain('http-equiv="refresh"');
	});

	it("lets a sandboxed page's Origin: null through to the proxy only, never to Kanban's API", () => {
		const decide = (url: string) => {
			const headers: Record<string, string> = {};
			const res = {
				setHeader: (name: string, value: string) => {
					headers[name] = value;
				},
				writeHead: () => undefined,
				end: () => undefined,
			} as unknown as ServerResponse;
			const req = {
				url,
				method: "POST",
				headers: { host: `127.0.0.1:${getKanbanRuntimePort()}`, origin: "null" },
			} as IncomingMessage;
			return { end: handleHttpRequest(req, res).end, headers };
		};
		expect(decide("/api/shortcut-port/41000/form")).toEqual({ end: false, headers: {} });
		expect(decide("/api/trpc/plans.approve").end).toBe(true);
		expect(decide("/api/shortcut-port/41000/../../trpc/plans.approve").end).toBe(true);
	});
});
