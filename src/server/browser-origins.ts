// Where the user's browser reaches this server (src/core/browser-page-origin.ts), kept in memory only. The web UI
// names its page origin on the state stream and on every terminal WebSocket; the server records it only for an
// upgrade that a browser made (it carries an Origin header and passed the host, CORS and passcode gates) and whose
// caller is the user (strict lookup), never for an agent session or a CLI call. It decides where links that the
// user opens point, so where GitHub sends the app manifest's code (`kanban github bot create`): an agent must never
// be able to choose it.
//
// The choice, in order: the origin the command asked for (`--origin`, the browser's own page), the origin of the
// page whose terminal the calling process runs in, the origin the user's browser last reached the server on, else
// localhost on the runtime port (what the pod publishes).
import type { IncomingMessage } from "node:http";

import { BROWSER_PAGE_ORIGIN_QUERY_PARAM, normalizeBrowserPageOrigin } from "../core/browser-page-origin";
import { getKanbanRuntimePort, isKanbanRuntimeHttps } from "../core/runtime-endpoint";
import type { RuntimeCaller } from "../isolation/session-identity";

export type BrowserOriginSource = "requested" | "terminal" | "browser" | "default";

export interface BrowserOriginChoice {
	origin: string;
	source: BrowserOriginSource;
}

/** How many terminals' viewer origins are kept (the most recent ones). */
const MAX_TERMINAL_ORIGINS = 500;

/** The origin the user's browser reaches Kanban on when nothing better is known: localhost on the runtime's port. */
export function getLocalBrowserOrigin(): string {
	return `${isKanbanRuntimeHttps() ? "https" : "http"}://localhost:${getKanbanRuntimePort()}`;
}

function readHeader(request: IncomingMessage, name: string): string | null {
	const value = request.headers[name];
	const first = Array.isArray(value) ? value[0] : value;
	return typeof first === "string" && first.trim() ? first.split(",")[0]?.trim() || null : null;
}

/**
 * The page origin a browser's WebSocket upgrade names: the web UI's `pageOrigin` parameter, else a proxy's
 * X-Forwarded-Host (+ X-Forwarded-Proto), else the Origin header. Null for a request without an Origin header:
 * browsers always send one on an upgrade, the CLI and agents' scripts usually don't.
 */
export function readBrowserPageOrigin(request: IncomingMessage, url: URL): string | null {
	const originHeader = readHeader(request, "origin");
	if (!originHeader) {
		return null;
	}
	const named = normalizeBrowserPageOrigin(url.searchParams.get(BROWSER_PAGE_ORIGIN_QUERY_PARAM));
	if (named) {
		return named;
	}
	const forwardedHost = readHeader(request, "x-forwarded-host");
	if (forwardedHost) {
		const forwardedProto = readHeader(request, "x-forwarded-proto") === "https" ? "https" : "http";
		const forwarded = normalizeBrowserPageOrigin(`${forwardedProto}://${forwardedHost}`);
		if (forwarded) {
			return forwarded;
		}
	}
	return normalizeBrowserPageOrigin(originHeader);
}

export interface BrowserOriginTracker {
	/** A page of the user's browser connected (the state stream or a terminal). */
	recordPage: (origin: string) => void;
	/** A page of the user's browser opened the terminal of `taskId` (the page counts as seen too). */
	recordTerminalViewer: (input: { workspaceId: string; taskId: string; origin: string }) => void;
	lastPageOrigin: () => string | null;
	terminalOrigin: (workspaceId: string, taskId: string) => string | null;
}

export function createBrowserOriginTracker(): BrowserOriginTracker {
	let lastPage: string | null = null;
	const terminals = new Map<string, string>();
	const keyOf = (workspaceId: string, taskId: string) => `${workspaceId}\u0000${taskId}`;
	const recordPage: BrowserOriginTracker["recordPage"] = (origin) => {
		lastPage = normalizeBrowserPageOrigin(origin) ?? lastPage;
	};
	return {
		recordPage,
		recordTerminalViewer: ({ workspaceId, taskId, origin }) => {
			const normalized = normalizeBrowserPageOrigin(origin);
			if (!normalized) {
				return;
			}
			recordPage(normalized);
			const key = keyOf(workspaceId, taskId);
			// Re-inserted, so the map's order is "least recently opened first".
			terminals.delete(key);
			terminals.set(key, normalized);
			while (terminals.size > MAX_TERMINAL_ORIGINS) {
				const oldest = terminals.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				terminals.delete(oldest);
			}
		},
		lastPageOrigin: () => lastPage,
		terminalOrigin: (workspaceId, taskId) => terminals.get(keyOf(workspaceId, taskId)) ?? null,
	};
}

/**
 * Records the page origin a WebSocket upgrade names, only for a browser's upgrade (readBrowserPageOrigin) whose
 * strict caller is the user: an agent session's or an unidentified process's upgrade records nothing.
 */
export function createBrowserUpgradeRecorder(deps: {
	tracker: BrowserOriginTracker;
	resolveStrictCaller: (request: IncomingMessage) => Promise<RuntimeCaller>;
}): (request: IncomingMessage, url: URL, terminal: { workspaceId: string; taskId: string } | null) => Promise<void> {
	return async (request, url, terminal) => {
		const origin = readBrowserPageOrigin(request, url);
		if (!origin || (await deps.resolveStrictCaller(request).catch(() => null))?.kind !== "user") {
			return;
		}
		if (terminal) {
			deps.tracker.recordTerminalViewer({ ...terminal, origin });
		} else {
			deps.tracker.recordPage(origin);
		}
	};
}

/** The origin for links the user opens (see the header for the order). */
export function chooseBrowserOrigin(input: {
	requested: string | null | undefined;
	callingTerminal: { workspaceId: string; taskId: string } | null;
	tracker: BrowserOriginTracker;
	fallback?: () => string;
}): BrowserOriginChoice {
	const requested = normalizeBrowserPageOrigin(input.requested);
	if (requested) {
		return { origin: requested, source: "requested" };
	}
	const terminal = input.callingTerminal
		? input.tracker.terminalOrigin(input.callingTerminal.workspaceId, input.callingTerminal.taskId)
		: null;
	if (terminal) {
		return { origin: terminal, source: "terminal" };
	}
	const page = input.tracker.lastPageOrigin();
	if (page) {
		return { origin: page, source: "browser" };
	}
	return { origin: (input.fallback ?? getLocalBrowserOrigin)(), source: "default" };
}
