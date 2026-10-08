import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One message as cline 3.x writes it to `<id>.messages.json`. */
export interface FakeClineMessage {
	role: "user" | "assistant";
	content: Array<Record<string, unknown>>;
	ts?: number;
}

export interface FakeClineSession {
	/** `<ms>_<rand>`, as the Cline CLI names its session dirs. */
	sessionId: string;
	cwd: string;
	status: "running" | "idle" | "completed" | "failed";
	startedAt: number;
	messages: FakeClineMessage[];
	/** The mtime of every file written here (default: the last message's ts). */
	writtenAt?: number;
	/** Teammate message files (`<agent>__<id>.messages.json`) and their mtimes. */
	teammates?: Record<string, number>;
}

export const toolUse = (name: string, ts: number, input: Record<string, unknown> = {}): FakeClineMessage => ({
	role: "assistant",
	content: [{ type: "tool_use", id: `toolu_${ts}`, name, input }],
	ts,
});

export const toolResult = (ts: number): FakeClineMessage => ({
	role: "user",
	content: [{ type: "tool_result", tool_use_id: `toolu_${ts}`, content: [{ query: "ls", result: "ok" }] }],
	ts,
});

export const textMessage = (role: "user" | "assistant", text: string, ts: number): FakeClineMessage => ({
	role,
	content: [{ type: "text", text }],
	ts,
});

/** Writes (or rewrites) one session dir under `sessionsPath`, with every file's mtime set. */
export function writeFakeClineSession(sessionsPath: string, session: FakeClineSession): string {
	const dir = join(sessionsPath, session.sessionId);
	mkdirSync(dir, { recursive: true });
	const writtenAt = new Date(session.writtenAt ?? session.messages.at(-1)?.ts ?? session.startedAt);
	const files: Array<[string, Date]> = [];
	const write = (name: string, content: unknown, at: Date) => {
		writeFileSync(join(dir, name), JSON.stringify(content));
		files.push([name, at]);
	};
	write(
		`${session.sessionId}.json`,
		{
			session_id: session.sessionId,
			status: session.status,
			started_at: new Date(session.startedAt).toISOString(),
			cwd: session.cwd,
			workspace_root: session.cwd,
		},
		writtenAt,
	);
	write(`${session.sessionId}.messages.json`, { messages: session.messages }, writtenAt);
	for (const [name, at] of Object.entries(session.teammates ?? {})) {
		write(`${name}.messages.json`, { messages: [] }, new Date(at));
	}
	for (const [name, at] of files) {
		utimesSync(join(dir, name), at, at);
	}
	return dir;
}
