import { z } from "zod";

export const TERMINAL_RESTORE_MAX_BYTES = 128 * 1024;
export const TERMINAL_RESTORE_SCROLLBACK = 200;
export const TERMINAL_HISTORY_PAGE_BYTES = 64 * 1024;
export const TERMINAL_HISTORY_PAGE_LINES = 500;
export const TERMINAL_WRITE_CHUNK_BYTES = 16 * 1024;

export const terminalHistoryRequestSchema = z.object({
	taskId: z.string().trim().min(1).max(200),
	end: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});
export type TerminalHistoryRequest = z.infer<typeof terminalHistoryRequestSchema>;

export const terminalHistoryPageSchema = z.object({
	available: z.boolean(),
	text: z.string(),
	start: z.number().int().nonnegative(),
	end: z.number().int().nonnegative(),
	totalBytes: z.number().int().nonnegative(),
	recordingError: z.boolean(),
});
export type TerminalHistoryPage = z.infer<typeof terminalHistoryPageSchema>;
