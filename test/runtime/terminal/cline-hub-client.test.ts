import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
	abortClineHubRun,
	type ClineHubConnection,
	connectClineHub,
	getClineHubDiscoveryPath,
	readClineHubDiscovery,
} from "../../../src/terminal/cline-hub-client";
import { createTempDir } from "../../utilities/temp-dir";

const TOKEN = "test-token";

interface FakeHubSession {
	status: string;
	/** Aborts still needed before the run ends (cline 3.0.70: the first abort leaves it waiting on hook.afterRun). */
	abortsToEnd: number;
}

interface FakeHub {
	url: string;
	sessions: Map<string, FakeHubSession>;
	commands: string[];
	close: () => Promise<void>;
}

async function startFakeHub(): Promise<FakeHub> {
	const sessions = new Map<string, FakeHubSession>();
	const commands: string[] = [];
	const server = new WebSocketServer({
		port: 0,
		host: "127.0.0.1",
		handleProtocols: (protocols) => (protocols.has(`cline-hub-auth.${TOKEN}`) ? `cline-hub-auth.${TOKEN}` : false),
		verifyClient: (info, done) => done(info.req.headers["sec-websocket-protocol"] === `cline-hub-auth.${TOKEN}`, 401),
	});
	await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	server.on("connection", (socket) => {
		socket.on("message", (raw) => {
			const frame = JSON.parse(String(raw)) as {
				kind: string;
				envelope: { command: string; requestId: string; sessionId?: string; payload?: Record<string, unknown> };
			};
			const { command, requestId, sessionId } = frame.envelope;
			commands.push(command);
			const reply = (body: Record<string, unknown>) =>
				socket.send(JSON.stringify({ kind: "reply", envelope: { version: "v1", requestId, ...body } }));
			const session = sessionId ? sessions.get(sessionId) : undefined;
			if (command === "client.register") {
				reply({ ok: true, payload: { clientId: "x" } });
			} else if (command === "session.get") {
				reply(
					session
						? { ok: true, payload: { session: { sessionId, status: session.status } } }
						: { ok: false, error: { code: "session_not_found", message: `Unknown session: ${sessionId}` } },
				);
			} else if (command === "run.abort") {
				if (session && session.status === "running") {
					session.abortsToEnd -= 1;
					if (session.abortsToEnd <= 0) {
						session.status = "idle";
					}
				}
				reply({ ok: true, payload: { applied: true } });
			} else {
				reply({ ok: false, error: { code: "unsupported_command", message: command } });
			}
		});
	});
	const { port } = server.address() as AddressInfo;
	return {
		url: `ws://127.0.0.1:${port}/hub`,
		sessions,
		commands,
		close: async () => {
			for (const client of server.clients) {
				client.terminate();
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

let cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.reverse()) {
		await cleanup();
	}
	cleanups = [];
});

async function connectToFakeHub(): Promise<{ hub: FakeHub; connection: ClineHubConnection }> {
	const hub = await startFakeHub();
	cleanups.push(hub.close);
	const connection = await connectClineHub({ url: hub.url, authToken: TOKEN }, { timeoutMs: 2_000 });
	cleanups.push(connection.close);
	return { hub, connection };
}

describe("cline hub discovery", () => {
	it("reads url and token from the discovery file; the env path wins over the data dir's", async () => {
		const temp = createTempDir("kanban-cline-hub-");
		cleanups.push(temp.cleanup);
		expect(getClineHubDiscoveryPath("/data", {})).toBe(join("/data", "locks", "hub", "production.json"));
		expect(getClineHubDiscoveryPath("/data", { CLINE_HUB_DISCOVERY_PATH: "/x/hub.json" })).toBe("/x/hub.json");
		const path = join(temp.path, "production.json");
		writeFileSync(path, JSON.stringify({ protocolVersion: "v1", url: "ws://127.0.0.1:1/hub", authToken: "t" }));
		expect(await readClineHubDiscovery(path)).toEqual({ url: "ws://127.0.0.1:1/hub", authToken: "t" });
	});

	it("refuses a missing file, a file without a token and another protocol version", async () => {
		const temp = createTempDir("kanban-cline-hub-");
		cleanups.push(temp.cleanup);
		const path = join(temp.path, "production.json");
		expect(await readClineHubDiscovery(path)).toBeNull();
		writeFileSync(path, JSON.stringify({ protocolVersion: "v1", url: "ws://127.0.0.1:1/hub" }));
		expect(await readClineHubDiscovery(path)).toBeNull();
		writeFileSync(path, JSON.stringify({ protocolVersion: "v2", url: "ws://127.0.0.1:1/hub", authToken: "t" }));
		expect(await readClineHubDiscovery(path)).toBeNull();
	});
});

describe("abortClineHubRun", () => {
	it("aborts again while the hub still says running (the gone client's hook.afterRun)", async () => {
		const { hub, connection } = await connectToFakeHub();
		hub.sessions.set("1_stuck", { status: "running", abortsToEnd: 2 });
		expect(await abortClineHubRun(connection, "1_stuck", "test", { settleMs: 1 })).toBe("ended");
		expect(hub.commands.filter((command) => command === "run.abort")).toHaveLength(2);
		expect(hub.commands[0]).toBe("client.register");
	});

	it("sends no abort for a session that doesn't run or that the hub doesn't know", async () => {
		const { hub, connection } = await connectToFakeHub();
		hub.sessions.set("1_idle", { status: "idle", abortsToEnd: 1 });
		expect(await abortClineHubRun(connection, "1_idle", "test", { settleMs: 1 })).toBe("ended");
		expect(await abortClineHubRun(connection, "1_gone", "test", { settleMs: 1 })).toBe("not_found");
		expect(hub.commands).not.toContain("run.abort");
	});

	it("gives up after its attempts", async () => {
		const { hub, connection } = await connectToFakeHub();
		hub.sessions.set("1_hard", { status: "running", abortsToEnd: 10 });
		expect(await abortClineHubRun(connection, "1_hard", "test", { attempts: 2, settleMs: 1 })).toBe("still_running");
		expect(hub.commands.filter((command) => command === "run.abort")).toHaveLength(2);
	});

	it("can't connect without the hub's token", async () => {
		const hub = await startFakeHub();
		cleanups.push(hub.close);
		await expect(connectClineHub({ url: hub.url, authToken: "wrong" }, { timeoutMs: 2_000 })).rejects.toThrow(
			/Cline hub/,
		);
	});
});
