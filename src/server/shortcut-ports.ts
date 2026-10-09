// Ports for shortcuts that ask for one (`{port}` / `{url}`, src/config/shortcut-utils.ts), and the browser's way to
// reach them (docs/fork/shortcuts.md). Kanban runs in a pod whose only published port is its own (3485), so a dev
// server a shortcut starts inside the pod is reachable from the browser only through the Kanban server:
// `/api/shortcut-port/<port>/<path>` is proxied to that port on loopback, for ports this server handed out (for
// 24 h), never any other port.
//
// What runs there is a card's code, which an agent wrote, served on Kanban's own origin. So every proxied response
// gets a CSP `sandbox` without `allow-same-origin`: the page runs in an opaque origin, can't call Kanban's API as the
// user (the CORS gate refuses its `Origin: null` everywhere but under this path), read Kanban's storage or set its
// cookies. Kanban's cookie and Authorization header never reach the app, the app's Set-Cookie never reaches the
// browser. What doesn't work through the proxy: URLs the app writes as absolute paths (`/assets/app.js` leaves the
// prefix; relative URLs and redirects to its own root work), WebSockets, cookies and browser storage. Inside the pod
// the port works directly, with none of these limits.
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { createConnection, createServer } from "node:net";

export const SHORTCUT_PORT_PROXY_PREFIX = "/api/shortcut-port/";
const PORT_TTL_MS = 24 * 60 * 60_000;
const MAX_HANDED_OUT = 200;
const ALLOCATE_ATTEMPTS = 20;
const PROBE_TIMEOUT_MS = 1_000;
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

/** Scripts and forms run, in an opaque origin. */
export const SHORTCUT_PROXY_SANDBOX_CSP =
	"sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

// RFC 9110 §7.6.1 hop-by-hop headers, plus what must not cross between Kanban and the app.
const DROPPED_REQUEST_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"cookie",
	"authorization",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"set-cookie",
]);

export interface HandedOutPort {
	port: number;
	workspaceId: string;
	/** Null: run from the board (the main checkout). */
	taskId: string | null;
	label: string;
	at: number;
}

export interface ShortcutPortRegistry {
	/** A free port for one run of a shortcut, remembered so the proxy serves it. */
	allocate: (input: Omit<HandedOutPort, "port" | "at">) => Promise<HandedOutPort>;
	find: (port: number) => HandedOutPort | null;
}

/** A free TCP port on loopback, as the OS hands it out right now (0 when it gave none). */
export function askOsForFreePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = address && typeof address === "object" ? address.port : 0;
			server.close(() => resolvePort(port));
		});
	});
}

export function createShortcutPortRegistry(
	deps: { askOs?: () => Promise<number>; now?: () => number } = {},
): ShortcutPortRegistry {
	const askOs = deps.askOs ?? askOsForFreePort;
	const now = deps.now ?? Date.now;
	const handedOut = new Map<number, HandedOutPort>();
	const prune = () => {
		for (const [port, entry] of handedOut) {
			if (now() - entry.at >= PORT_TTL_MS) {
				handedOut.delete(port);
			}
		}
		// Oldest first (insertion order).
		while (handedOut.size >= MAX_HANDED_OUT) {
			const oldest = handedOut.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			handedOut.delete(oldest);
		}
	};
	return {
		allocate: async (input) => {
			prune();
			for (let attempt = 0; attempt < ALLOCATE_ATTEMPTS; attempt += 1) {
				const port = await askOs();
				// A run that hasn't bound its port yet is free to the OS, so never hand the same port out twice.
				if (port > 0 && !handedOut.has(port)) {
					const entry = { ...input, port, at: now() };
					handedOut.set(port, entry);
					return entry;
				}
			}
			throw new Error("no free port for the shortcut");
		},
		find: (port) => {
			const entry = handedOut.get(port);
			return entry && now() - entry.at < PORT_TTL_MS ? entry : null;
		},
	};
}

export function buildShortcutPortProxyPath(port: number): string {
	return `${SHORTCUT_PORT_PROXY_PREFIX}${port}/`;
}

export function isShortcutPortProxyPath(pathname: string): boolean {
	return pathname.startsWith(SHORTCUT_PORT_PROXY_PREFIX);
}

/** `/api/shortcut-port/<port>/<rest>` from the raw request URL; `upstreamPath` null when the slash after the port is missing. */
export function parseShortcutPortProxyPath(rawUrl: string): { port: number; upstreamPath: string | null } | null {
	const match = /^\/api\/shortcut-port\/(\d{1,5})(.*)$/u.exec(rawUrl);
	const port = Number(match?.[1]);
	if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
		return null;
	}
	const tail = match[2] ?? "";
	return { port, upstreamPath: tail.startsWith("/") ? tail : null };
}

function formatHostPort(host: string, port: number): string {
	return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function buildUpstreamRequestHeaders(
	headers: IncomingHttpHeaders,
	input: { host: string; port: number; basePath: string; tls: boolean },
): OutgoingHttpHeaders {
	const result: OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || DROPPED_REQUEST_HEADERS.has(name) || name.startsWith("x-kanban-")) {
			continue;
		}
		result[name] = value;
	}
	result.host = formatHostPort(input.host, input.port);
	if (headers.host) {
		result["x-forwarded-host"] = headers.host;
	}
	result["x-forwarded-proto"] = input.tls ? "https" : "http";
	result["x-forwarded-prefix"] = input.basePath.replace(/\/$/u, "");
	return result;
}

/** A redirect to the app's own root or loopback address stays under the proxy path. */
export function rewriteProxiedLocation(location: string, input: { port: number; basePath: string }): string {
	const base = input.basePath.replace(/\/$/u, "");
	if (location.startsWith("/") && !location.startsWith("//")) {
		return `${base}${location}`;
	}
	for (const origin of [
		`http://localhost:${input.port}`,
		`http://127.0.0.1:${input.port}`,
		`http://[::1]:${input.port}`,
	]) {
		if (location === origin || location.startsWith(`${origin}/`)) {
			return `${base}${location.slice(origin.length) || "/"}`;
		}
	}
	return location;
}

export function buildDownstreamResponseHeaders(
	headers: IncomingHttpHeaders,
	input: { port: number; basePath: string },
): OutgoingHttpHeaders {
	const result: OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name)) {
			continue;
		}
		result[name] = name === "location" && typeof value === "string" ? rewriteProxiedLocation(value, input) : value;
	}
	// A comma-separated list is several policies, each enforced (CSP3 §3.1): the app's own and the sandbox.
	const appPolicy = headers["content-security-policy"];
	result["content-security-policy"] = appPolicy
		? `${appPolicy}, ${SHORTCUT_PROXY_SANDBOX_CSP}`
		: SHORTCUT_PROXY_SANDBOX_CSP;
	return result;
}

function canConnect(host: string, port: number): Promise<boolean> {
	return new Promise((resolveProbe) => {
		const socket = createConnection({ host, port });
		const done = (result: boolean) => {
			socket.destroy();
			resolveProbe(result);
		};
		socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

/** The loopback address something listens on at `port` (IPv4 first; `localhost` is ::1 on some setups). */
export async function findListeningHost(port: number): Promise<string | null> {
	for (const host of LOOPBACK_HOSTS) {
		if (await canConnect(host, port)) {
			return host;
		}
	}
	return null;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

function sendNotice(res: ServerResponse, statusCode: number, title: string, detail: string, reload: boolean): void {
	res.writeHead(statusCode, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Security-Policy": SHORTCUT_PROXY_SANDBOX_CSP,
	});
	res.end(
		`<!doctype html><meta charset="utf-8">${reload ? '<meta http-equiv="refresh" content="2">' : ""}<title>${escapeHtml(title)}</title><body style="font-family:sans-serif;background:#1F2428;color:#E6EDF3;padding:24px"><h3>${escapeHtml(title)}</h3><p style="color:#8B949E">${escapeHtml(detail)}</p></body>`,
	);
}

export interface ShortcutPortProxyDependencies {
	ports: Pick<ShortcutPortRegistry, "find">;
	tls: boolean;
	findHost?: (port: number) => Promise<string | null>;
	log?: (message: string) => void;
}

/** Serves a request under /api/shortcut-port/. */
export function createShortcutPortProxyHandler(deps: ShortcutPortProxyDependencies) {
	const findHost = deps.findHost ?? findListeningHost;
	return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const parsed = parseShortcutPortProxyPath(req.url ?? "");
		if (!parsed || !deps.ports.find(parsed.port)) {
			sendNotice(
				res,
				404,
				"No such shortcut port",
				"Only ports Kanban handed to a shortcut run ({port} / {url}) in the last 24 h are served here.",
				false,
			);
			return;
		}
		const basePath = buildShortcutPortProxyPath(parsed.port);
		if (parsed.upstreamPath === null) {
			// Relative URLs in the app's pages resolve against the slash after the port.
			const query = (req.url ?? "").slice(basePath.length - 1);
			res.writeHead(308, { Location: `${basePath}${query}`, "Cache-Control": "no-store" });
			res.end();
			return;
		}
		const host = await findHost(parsed.port);
		if (!host) {
			sendNotice(
				res,
				503,
				`Nothing listens on port ${parsed.port} yet`,
				"The shortcut's command may still be starting; this page reloads every 2 s. Check its terminal.",
				true,
			);
			return;
		}
		const upstream = httpRequest(
			{
				host,
				port: parsed.port,
				method: req.method,
				path: parsed.upstreamPath,
				// No pooled keep-alive connections: an idle one from the server would make the process reaper take the
				// app for shared (incoming connections from outside the card) and leave it running after Done.
				agent: false,
				headers: buildUpstreamRequestHeaders(req.headers, { host, port: parsed.port, basePath, tls: deps.tls }),
			},
			(upstreamRes) => {
				res.writeHead(
					upstreamRes.statusCode ?? 502,
					buildDownstreamResponseHeaders(upstreamRes.headers, { port: parsed.port, basePath }),
				);
				upstreamRes.pipe(res);
			},
		);
		upstream.on("error", (error) => {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			deps.log?.(`[shortcut-port] proxy to port ${parsed.port} failed: ${error.message}`);
			sendNotice(res, 502, `Port ${parsed.port} didn't answer`, error.message, false);
		});
		res.on("close", () => {
			if (!res.writableFinished) {
				upstream.destroy();
			}
		});
		req.pipe(upstream);
	};
}
