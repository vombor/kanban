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

export interface ClineSessionFileReader {
	/** The newest cline 3.x session in `sessionsPath` whose cwd or workspace root is `workspacePath`, or null. */
	readLatestSession: (sessionsPath: string, workspacePath: string) => Promise<ClineSessionSnapshot | null>;
}

/**
 * A session's cwd and start time never change, so they are cached per session dir (only once its `<id>.json`
 * could be read). A tick then reads one `<id>.json` and one messages file per watched card.
 */
export function createClineSessionFileReader(): ClineSessionFileReader {
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

	return {
		readLatestSession: async (sessionsPath, workspacePath) => {
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
			if (!best) {
				return null;
			}
			const dir = join(sessionsPath, best.sessionId);
			const file = await readJsonObject(join(dir, `${best.sessionId}.json`));
			const messagesPath = join(dir, `${best.sessionId}.messages.json`);
			let messagesWrittenAt: number | null = null;
			let lastMessage: ClineSessionMessage | null = null;
			try {
				messagesWrittenAt = (await stat(messagesPath)).mtimeMs;
				const parsed: unknown = JSON.parse(await readFile(messagesPath, "utf8"));
				const messages = Array.isArray(parsed)
					? parsed
					: ((parsed as { messages?: unknown } | null)?.messages ?? []);
				lastMessage = Array.isArray(messages) ? toMessage(messages.at(-1)) : null;
			} catch {
				// No messages yet, or a half-written file: nothing to decide on this tick.
			}
			return {
				sessionId: best.sessionId,
				status: typeof file?.status === "string" ? file.status : null,
				startedAt: best.startedAt || null,
				messagesWrittenAt,
				lastMessage,
			};
		},
	};
}
