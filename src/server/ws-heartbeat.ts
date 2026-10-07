// Server-side websocket keepalive for long-lived browser streams.
//
// Reverse proxies and tunnels (Cloudflare, cloudflared, some Caddy setups) close
// websockets that carry no frames for a while (Cloudflare: ~100 s). The board's
// runtime-state stream can be silent for minutes when nothing changes, so behind a
// tunnel the socket was dropped every few minutes and the board needed a reload.
//
// Ping every client each interval. A client that misses `missedLimit` pongs in a
// row is terminated, so its normal close handlers run and the browser reconnects.
import { WebSocket, type WebSocketServer } from "ws";

export const RUNTIME_STATE_WS_HEARTBEAT_INTERVAL_MS = 25_000;

export interface WebSocketHeartbeatOptions {
	intervalMs: number;
	missedLimit?: number;
}

export function startWebSocketKeepalive(wss: WebSocketServer, options: WebSocketHeartbeatOptions): () => void {
	const missedLimit = Math.max(1, options.missedLimit ?? 2);
	const missedByClient = new WeakMap<WebSocket, number>();
	const onConnection = (client: WebSocket) => {
		missedByClient.set(client, 0);
		client.on("pong", () => {
			missedByClient.set(client, 0);
		});
	};
	wss.on("connection", onConnection);
	const timer = setInterval(() => {
		for (const client of wss.clients) {
			if (client.readyState !== WebSocket.OPEN) {
				continue;
			}
			const missed = missedByClient.get(client) ?? 0;
			if (missed >= missedLimit) {
				client.terminate();
				continue;
			}
			missedByClient.set(client, missed + 1);
			try {
				client.ping();
			} catch {
				client.terminate();
			}
		}
	}, options.intervalMs);
	timer.unref();
	return () => {
		clearInterval(timer);
		wss.off("connection", onConnection);
	};
}
