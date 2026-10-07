import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startWebSocketKeepalive } from "../../../src/server/ws-heartbeat";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("startWebSocketKeepalive", () => {
	let server: Server | null = null;
	let wss: WebSocketServer | null = null;
	let stop: (() => void) | null = null;

	afterEach(async () => {
		stop?.();
		for (const client of wss?.clients ?? []) client.terminate();
		await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = null;
		wss = null;
		stop = null;
	});

	const listen = async () => {
		server = createServer();
		wss = new WebSocketServer({ server });
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
		return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
	};

	it("pings idle clients so a responsive socket stays open", async () => {
		const url = await listen();
		stop = startWebSocketKeepalive(wss as WebSocketServer, { intervalMs: 30, missedLimit: 2 });
		const client = new WebSocket(url);
		let pings = 0;
		client.on("ping", () => {
			pings += 1;
		});
		await new Promise((resolve) => client.on("open", resolve));
		await wait(200);
		expect(pings).toBeGreaterThanOrEqual(3);
		expect(client.readyState).toBe(WebSocket.OPEN);
		client.close();
	});

	it("terminates a client that misses pongs for the configured number of intervals", async () => {
		const url = await listen();
		stop = startWebSocketKeepalive(wss as WebSocketServer, { intervalMs: 30, missedLimit: 2 });
		// autoPong off: the client never answers pings, like a socket a tunnel silently dropped.
		const client = new WebSocket(url, { autoPong: false });
		const closed = new Promise<number>((resolve) => client.on("close", (code) => resolve(code)));
		await new Promise((resolve) => client.on("open", resolve));
		const code = await Promise.race([closed, wait(1000).then(() => -1)]);
		expect(code).not.toBe(-1);
	});
});
