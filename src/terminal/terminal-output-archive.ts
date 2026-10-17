// The browser reads one bounded page, never the full output file. Agent-owned transcripts remain untouched.
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, mkdirSync, openSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";

import {
	TERMINAL_HISTORY_PAGE_BYTES,
	TERMINAL_HISTORY_PAGE_LINES,
	type TerminalHistoryPage,
	type TerminalHistoryRequest,
} from "../core/terminal-history";
import { getKanbanDataPath } from "../state/kanban-home";

const failedArchives = new Set<string>();

function archivePath(workspaceId: string, taskId: string, homePath?: string): string {
	const name = createHash("sha256").update(taskId).digest("hex");
	return join(getKanbanDataPath(homePath), workspaceId, "terminal-output", `${name}.log`);
}

/** Small PTY chunks append directly: no unbounded in-memory archive queue and no long-lived file descriptors. */
export function appendTerminalOutput(
	workspaceId: string,
	taskId: string,
	chunk: Buffer,
	homePath?: string,
	onError?: (message: string) => void,
): void {
	const path = archivePath(workspaceId, taskId, homePath);
	try {
		mkdirSync(join(getKanbanDataPath(homePath), workspaceId, "terminal-output"), { recursive: true, mode: 0o700 });
		const file = openSync(
			path,
			constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			appendFileSync(file, chunk);
		} finally {
			closeSync(file);
		}
	} catch {
		if (!failedArchives.has(path)) {
			try {
				onError?.(
					`Terminal output archive unavailable for ${JSON.stringify({ workspaceId, taskId })}; agent execution is unchanged.`,
				);
			} catch {
				/* Diagnostics must not turn an archive/storage problem into an agent process failure. */
			}
		}
		failedArchives.add(path);
	}
}

export async function readTerminalOutputPage(
	workspaceId: string,
	input: TerminalHistoryRequest,
	homePath?: string,
): Promise<TerminalHistoryPage> {
	const path = archivePath(workspaceId, input.taskId, homePath);
	let file: FileHandle;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { available: false, text: "", start: 0, end: 0, totalBytes: 0, recordingError: failedArchives.has(path) };
	}
	try {
		const { size } = await file.stat();
		const end = Math.min(input.end ?? size, size);
		const start = Math.max(0, end - TERMINAL_HISTORY_PAGE_BYTES);
		const buffer = Buffer.alloc(end - start);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
		let offset = 0;
		let lines = 0;
		for (let index = bytesRead - 1; index >= 0; index -= 1) {
			if (buffer[index] === 10 && ++lines > TERMINAL_HISTORY_PAGE_LINES) {
				offset = index + 1;
				break;
			}
		}
		// Move the page boundary past UTF-8 continuation bytes. The skipped complete character belongs to the older page.
		while (offset < bytesRead && ((buffer[offset] ?? 0) & 0xc0) === 0x80) offset += 1;
		return {
			available: true,
			text: buffer.subarray(offset, bytesRead).toString("utf8"),
			start: start + offset,
			end: start + bytesRead,
			totalBytes: size,
			recordingError: failedArchives.has(path),
		};
	} finally {
		await file.close();
	}
}
