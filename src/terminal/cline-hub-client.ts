// Talks to the Cline CLI's shared hub daemon (cline 3.x, verified against 3.0.70): it ends a session's run there.
//
// Every Cline card's run lives in the one hub daemon, not in the card's TUI. When the TUI goes (Done, a dead
// session), the run doesn't: it keeps waiting on a capability request (a hook such as `hook.afterTool`) addressed
// to the TUI client that is gone, and the hub heartbeats it forever (foo QA 33288, session 1791628989887_naxx0,
// 2026-10-10: TUI gone at 10:44:43Z, `run.start` still pending 10 h later; issue #28). The process reaper never
// signals the hub (it serves every card), so the run is ended through the hub's own command, `run.abort`.
//
// The hub's protocol, as cline 3.0.70 speaks it: the discovery file (`CLINE_HUB_DISCOVERY_PATH`, else
// `<cline data dir>/locks/hub/production.json`) names `url` and `authToken`; a websocket to `url` with the
// subprotocol `cline-hub-auth.<authToken>`; frames `{ kind: "command", envelope: { version: "v1", command,
// requestId, clientId, sessionId, payload } }` answered by `{ kind: "reply", envelope: { requestId, ok, payload,
// error } }`; `client.register` first. `run.abort` rejects the session's pending capability requests and aborts the
// run, but the run's abort path then asks the gone client for `hook.afterRun` and waits again, so one abort is not
// enough: `abortClineHubRun` reads `session.get` after each and aborts again while the hub still says "running".
// Reads the discovery file only; Kanban writes nothing under Cline's dirs.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";

const HUB_DISCOVERY_ENV = "CLINE_HUB_DISCOVERY_PATH";
const HUB_AUTH_SUBPROTOCOL_PREFIX = "cline-hub-auth.";
const HUB_PROTOCOL_VERSION = "v1";
const CLIENT_TYPE = "kanban";
const SESSION_NOT_FOUND = "session_not_found";

export const DEFAULT_CLINE_HUB_TIMEOUT_MS = 5_000;
export const DEFAULT_CLINE_HUB_ABORT_ATTEMPTS = 3;
/** How long the hub gets to end the run after an abort before Kanban looks again (it took ~70 ms in the probe). */
export const DEFAULT_CLINE_HUB_ABORT_SETTLE_MS = 500;

export interface ClineHubDiscovery {
	url: string;
	authToken: string;
}

/** The discovery file the Cline CLI itself uses for its shared hub (the env override wins, as in Cline). */
export function getClineHubDiscoveryPath(clineDataDir: string, env: NodeJS.ProcessEnv = process.env): string {
	return env[HUB_DISCOVERY_ENV]?.trim() || join(clineDataDir, "locks", "hub", "production.json");
}

/** The hub's url and auth token, or null when no hub has written a usable discovery file. */
export async function readClineHubDiscovery(discoveryPath: string): Promise<ClineHubDiscovery | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(discoveryPath, "utf8"));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") {
		return null;
	}
	const { url, authToken, protocolVersion } = parsed as Record<string, unknown>;
	if (typeof url !== "string" || !url || typeof authToken !== "string" || !authToken) {
		return null;
	}
	if (typeof protocolVersion === "string" && protocolVersion !== HUB_PROTOCOL_VERSION) {
		return null;
	}
	return { url, authToken };
}

interface HubReplyEnvelope {
	requestId?: string;
	ok?: boolean;
	payload?: Record<string, unknown>;
	error?: { code?: string; message?: string };
}

export class ClineHubCommandError extends Error {
	constructor(
		readonly command: string,
		readonly code: string | null,
		message: string,
	) {
		super(`Cline hub ${command} failed${code ? ` (${code})` : ""}: ${message}`);
		this.name = "ClineHubCommandError";
	}
}

export interface ClineHubConnection {
	command: (
		command: string,
		payload: Record<string, unknown> | undefined,
		sessionId?: string,
	) => Promise<HubReplyEnvelope>;
	close: () => void;
}

/** Opens a connection to the hub and registers as a client; rejects when the hub can't be reached in time. */
export async function connectClineHub(
	discovery: ClineHubDiscovery,
	options: { timeoutMs?: number } = {},
): Promise<ClineHubConnection> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_CLINE_HUB_TIMEOUT_MS;
	const clientId = `kanban-${process.pid}-${Date.now().toString(36)}`;
	const socket = new WebSocket(discovery.url, [`${HUB_AUTH_SUBPROTOCOL_PREFIX}${discovery.authToken}`]);
	const pending = new Map<string, { resolve: (reply: HubReplyEnvelope) => void; reject: (error: Error) => void }>();
	let nextRequest = 0;
	let closedError: Error | null = null;

	socket.on("message", (raw) => {
		let frame: { kind?: unknown; envelope?: HubReplyEnvelope };
		try {
			frame = JSON.parse(String(raw)) as typeof frame;
		} catch {
			return;
		}
		const requestId = frame.kind === "reply" ? frame.envelope?.requestId : undefined;
		const waiter = requestId ? pending.get(requestId) : undefined;
		if (requestId && waiter && frame.envelope) {
			pending.delete(requestId);
			waiter.resolve(frame.envelope);
		}
	});
	socket.on("close", () => {
		closedError ??= new Error("Cline hub connection closed");
		for (const waiter of pending.values()) {
			waiter.reject(closedError);
		}
		pending.clear();
	});

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error(`Timed out connecting to the Cline hub after ${timeoutMs} ms`));
		}, timeoutMs);
		socket.once("open", () => {
			clearTimeout(timer);
			resolve();
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			closedError = error;
			reject(new Error(`Could not connect to the Cline hub: ${error.message}`));
		});
	});

	const command: ClineHubConnection["command"] = async (name, payload, sessionId) => {
		if (closedError || socket.readyState !== WebSocket.OPEN) {
			throw closedError ?? new Error("Cline hub connection is not open");
		}
		const requestId = `kanbanreq_${++nextRequest}`;
		const reply = new Promise<HubReplyEnvelope>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(requestId);
				reject(new Error(`Cline hub ${name} timed out after ${timeoutMs} ms`));
			}, timeoutMs);
			pending.set(requestId, {
				resolve: (envelope) => {
					clearTimeout(timer);
					resolve(envelope);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
		socket.send(
			JSON.stringify({
				kind: "command",
				envelope: { version: HUB_PROTOCOL_VERSION, command: name, requestId, clientId, sessionId, payload },
			}),
		);
		const envelope = await reply;
		if (!envelope.ok) {
			throw new ClineHubCommandError(
				name,
				envelope.error?.code ?? null,
				envelope.error?.message ?? "no reason given",
			);
		}
		return envelope;
	};

	const close = () => {
		closedError ??= new Error("Cline hub connection closed");
		socket.close();
	};

	try {
		await command("client.register", {
			clientId,
			clientType: CLIENT_TYPE,
			displayName: "Kanban",
			transport: "native",
			actorKind: "client",
			capabilities: [],
			metadata: { pid: process.pid },
		});
	} catch (error) {
		close();
		throw error;
	}
	return { command, close };
}

/** "ended": the hub no longer runs it (or didn't run it to begin with); "not_found": the hub doesn't know the session; "still_running": every abort failed to end it. */
export type ClineHubAbortOutcome = "ended" | "not_found" | "still_running";

const wait = async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readHubSessionStatus(connection: ClineHubConnection, sessionId: string): Promise<string | null> {
	try {
		const reply = await connection.command("session.get", undefined, sessionId);
		const session = reply.payload?.session as { status?: unknown } | undefined;
		return typeof session?.status === "string" ? session.status : null;
	} catch (error) {
		if (error instanceof ClineHubCommandError && error.code === SESSION_NOT_FOUND) {
			return null;
		}
		throw error;
	}
}

/** Aborts a session's run in the hub until the hub says it no longer runs (see the header for why once is not enough). */
export async function abortClineHubRun(
	connection: ClineHubConnection,
	sessionId: string,
	reason: string,
	options: { attempts?: number; settleMs?: number } = {},
): Promise<ClineHubAbortOutcome> {
	const attempts = options.attempts ?? DEFAULT_CLINE_HUB_ABORT_ATTEMPTS;
	const settleMs = options.settleMs ?? DEFAULT_CLINE_HUB_ABORT_SETTLE_MS;
	const initial = await readHubSessionStatus(connection, sessionId);
	if (initial !== "running") {
		return initial === null ? "not_found" : "ended";
	}
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		await connection.command("run.abort", { sessionId, reason }, sessionId);
		await wait(settleMs);
		const status = await readHubSessionStatus(connection, sessionId);
		if (status !== "running") {
			return status === null ? "not_found" : "ended";
		}
	}
	return "still_running";
}
