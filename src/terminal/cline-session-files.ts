// Reads the Cline CLI's (cline 3.x) own session files: `<cline data dir>/sessions/<ms>_<rand>/` with
// `<id>.json` (status, started_at, cwd, workspace_root) and `<id>.messages.json` ({ messages: [...] }).
// A card's session is the one whose cwd / workspace_root is the card's worktree; the newest one by
// started_at is the current one (a chat that resumes a card can start a new session dir).
// Session dirs named "<taskId>-<ms>-<rand>" belong to the embedded Cline SDK agent, which this fork removed.
//
// Ported from archive/devteam-kit:lib/cline-session.cjs@6da71597 (sessionDirs, latest, messages).
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getClineDataPath } from "../state/kanban-home";
import type { ClineSessionMessage, ClineSessionSnapshot } from "./cline-turn-outcome";

const SESSIONS_DIR = "sessions";
const CLI_SESSION_DIR_PATTERN = /^\d+_[a-z0-9]+$/i;

export function getClineSessionsPath(clineDataPath: string = getClineDataPath()): string {
	return join(clineDataPath, SESSIONS_DIR);
}

interface SessionMeta {
	/** Resolved cwd / workspace_root, without a trailing separator. */
	paths: string[];
	startedAt: number | null;
}

interface SessionMetaFile {
	status?: unknown;
	started_at?: unknown;
	cwd?: unknown;
	workspace_root?: unknown;
}

function normalizePath(path: string): string {
	return resolve(path).replace(/[\\/]+$/u, "");
}

function parseTime(value: unknown): number | null {
	if (typeof value !== "string") {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function toMessage(value: unknown): ClineSessionMessage | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const { role, content } = value as { role?: unknown; content?: unknown };
	if (typeof role !== "string") {
		return null;
	}
	if (typeof content === "string") {
		return { role, content };
	}
	if (!Array.isArray(content)) {
		return { role, content: [] };
	}
	return {
		role,
		content: content
			.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
			.map((block) => ({
				type: typeof block.type === "string" ? block.type : "",
				...(typeof block.text === "string" ? { text: block.text } : {}),
			})),
	};
}

/** One content block as recovery needs it: tool results only by size (and the query or command that made them). */
export interface ClineSessionDetailBlock {
	type: string;
	text?: string;
	/** JSON length of a tool_result's content. */
	size?: number;
	/** A tool_result's `query` / `command` (the tool call that produced it), cut to 160 characters. */
	query?: string;
}

export interface ClineSessionDetailMessage {
	role: string;
	content: ClineSessionDetailBlock[];
	/** `metrics.outputTokens` of an assistant message, when Cline recorded it. */
	outputTokens: number | null;
	/** `ts` of the message (epoch ms), when Cline recorded it. */
	ts: number | null;
}

/** Everything recovery reads from a card's newest session (premature stops, hung requests, overflow culprits). */
export interface ClineSessionDetail {
	snapshot: ClineSessionSnapshot;
	messages: ClineSessionDetailMessage[];
	/** The newest mtime of any file in the session dir. */
	lastWriteAt: number | null;
}

export interface ClineSessionFileReader {
	/** The newest cline 3.x session in `sessionsPath` whose cwd or workspace root is `workspacePath`, or null. */
	readLatestSession: (sessionsPath: string, workspacePath: string) => Promise<ClineSessionSnapshot | null>;
	/** Every message of that session (`<id>.messages.json` as written), or null when there is none yet. */
	readLatestSessionMessages: (sessionsPath: string, workspacePath: string) => Promise<unknown[] | null>;
}

function readMessagesArray(parsed: unknown): unknown[] {
	const messages = Array.isArray(parsed) ? parsed : ((parsed as { messages?: unknown } | null)?.messages ?? []);
	return Array.isArray(messages) ? messages : [];
}

export interface ClineSessionDetailReader {
	/** The same session as readLatestSession, with all its messages and the dir's last write, or null. */
	readLatestSessionDetail: (sessionsPath: string, workspacePath: string) => Promise<ClineSessionDetail | null>;
}

const QUERY_MAX_LENGTH = 160;

function toDetailBlock(block: Record<string, unknown>): ClineSessionDetailBlock {
	const type = typeof block.type === "string" ? block.type : "";
	if (type === "tool_result") {
		const content = block.content ?? "";
		const first = Array.isArray(content) ? (content[0] as Record<string, unknown> | undefined) : undefined;
		const query = first?.query ?? first?.command;
		return {
			type,
			size: JSON.stringify(content).length,
			...(typeof query === "string" ? { query: query.slice(0, QUERY_MAX_LENGTH) } : {}),
		};
	}
	return { type, ...(typeof block.text === "string" ? { text: block.text } : {}) };
}

function toDetailMessage(value: unknown): ClineSessionDetailMessage | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const { role, content, metrics, ts } = value as {
		role?: unknown;
		content?: unknown;
		metrics?: unknown;
		ts?: unknown;
	};
	if (typeof role !== "string") {
		return null;
	}
	const outputTokens =
		metrics && typeof metrics === "object" ? (metrics as { outputTokens?: unknown }).outputTokens : null;
	const blocks =
		typeof content === "string"
			? [{ type: "text", text: content }]
			: Array.isArray(content)
				? content
						.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
						.map(toDetailBlock)
				: [];
	const time = typeof ts === "number" ? ts : typeof ts === "string" ? Number(ts) : Number.NaN;
	return {
		role,
		content: blocks,
		outputTokens: typeof outputTokens === "number" ? outputTokens : null,
		ts: Number.isFinite(time) ? time : null,
	};
}

async function readNewestWrite(dir: string): Promise<number | null> {
	try {
		const times = await Promise.all(
			(await readdir(dir)).map(
				async (name) =>
					await stat(join(dir, name)).then(
						(entry) => entry.mtimeMs,
						() => 0,
					),
			),
		);
		return times.length > 0 ? Math.max(...times) : null;
	} catch {
		return null;
	}
}

/**
 * A session's cwd and start time never change, so they are cached per session dir (only once its `<id>.json`
 * could be read). A tick then reads one `<id>.json` and one messages file per watched card.
 */
export function createClineSessionFileReader(): ClineSessionFileReader & ClineSessionDetailReader {
	const metaCache = new Map<string, SessionMeta>();

	const readMeta = async (sessionsPath: string, sessionId: string): Promise<SessionMeta | null> => {
		const key = join(sessionsPath, sessionId);
		const cached = metaCache.get(key);
		if (cached) {
			return cached;
		}
		const file = (await readJsonObject(join(key, `${sessionId}.json`))) as SessionMetaFile | null;
		if (!file) {
			return null; // not written yet: look again next time
		}
		const paths = [file.workspace_root, file.cwd]
			.filter((path): path is string => typeof path === "string" && path.trim() !== "")
			.map(normalizePath);
		const meta: SessionMeta = { paths, startedAt: parseTime(file.started_at) };
		metaCache.set(key, meta);
		return meta;
	};

	const findLatestSessionId = async (sessionsPath: string, workspacePath: string): Promise<string | null> => {
		let names: string[];
		try {
			names = (await readdir(sessionsPath)).filter((name) => CLI_SESSION_DIR_PATTERN.test(name));
		} catch {
			return null;
		}
		const target = normalizePath(workspacePath);
		let best: { sessionId: string; startedAt: number } | null = null;
		for (const sessionId of names) {
			const meta = await readMeta(sessionsPath, sessionId);
			if (!meta?.paths.includes(target)) {
				continue;
			}
			const startedAt = meta.startedAt ?? 0;
			if (!best || startedAt > best.startedAt) {
				best = { sessionId, startedAt };
			}
		}
		return best?.sessionId ?? null;
	};

	const readSession = async (
		sessionsPath: string,
		sessionId: string,
	): Promise<{ snapshot: ClineSessionSnapshot; messages: unknown[] }> => {
		const dir = join(sessionsPath, sessionId);
		const file = await readJsonObject(join(dir, `${sessionId}.json`));
		const messagesPath = join(dir, `${sessionId}.messages.json`);
		let messagesWrittenAt: number | null = null;
		let messages: unknown[] = [];
		try {
			messagesWrittenAt = (await stat(messagesPath)).mtimeMs;
			messages = readMessagesArray(JSON.parse(await readFile(messagesPath, "utf8")));
		} catch {
			// No messages yet, or a half-written file: nothing to decide on this tick.
		}
		const startedAt = (await readMeta(sessionsPath, sessionId))?.startedAt ?? null;
		return {
			snapshot: {
				sessionId,
				status: typeof file?.status === "string" ? file.status : null,
				startedAt: startedAt || null,
				messagesWrittenAt,
				lastMessage: toMessage(messages.at(-1)),
			},
			messages,
		};
	};

	return {
		readLatestSession: async (sessionsPath, workspacePath) => {
			const sessionId = await findLatestSessionId(sessionsPath, workspacePath);
			return sessionId ? (await readSession(sessionsPath, sessionId)).snapshot : null;
		},
		readLatestSessionDetail: async (sessionsPath, workspacePath) => {
			const sessionId = await findLatestSessionId(sessionsPath, workspacePath);
			if (!sessionId) {
				return null;
			}
			const { snapshot, messages } = await readSession(sessionsPath, sessionId);
			return {
				snapshot,
				messages: messages
					.map(toDetailMessage)
					.filter((message): message is ClineSessionDetailMessage => message !== null),
				lastWriteAt: await readNewestWrite(join(sessionsPath, sessionId)),
			};
		},
		readLatestSessionMessages: async (sessionsPath, workspacePath) => {
			const sessionId = await findLatestSessionId(sessionsPath, workspacePath);
			if (!sessionId) {
				return null;
			}
			try {
				const parsed: unknown = JSON.parse(
					await readFile(join(sessionsPath, sessionId, `${sessionId}.messages.json`), "utf8"),
				);
				return readMessagesArray(parsed);
			} catch {
				return null;
			}
		},
	};
}
