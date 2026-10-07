import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { RuntimeAgentId } from "../core/api-contract";
import { getTaskWorktreeSearchRootPaths } from "../state/kanban-home";
import {
	type AgentWorkspaceTrustResult,
	resolvePreTrustRoot,
	resolveWorkspaceTrustRoot,
	withTrustConfigFileLock,
} from "./workspace-trust-root";

export const WORKSPACE_TRUST_CONFIRM_DELAY_MS = 100;
// Claude Code's trust dialog drops keys that arrive within 150 ms of it opening, and every dropped key
// restarts that window (2.1.291). Wait well past it before typing.
export const CLAUDE_WORKSPACE_TRUST_KEY_DELAY_MS = 500;
export const CLAUDE_WORKSPACE_TRUST_MAX_NAVIGATION_KEYS = 3;
const ARROW_DOWN = "\u001b[B";

const DEFAULT_TRUST_WRITE_ATTEMPTS = 5;

interface ClaudeConfigFile {
	projects?: Record<string, Record<string, unknown> | undefined>;
	[key: string]: unknown;
}

export interface ClaudeWorkspaceTrustOptions {
	configFilePath?: string;
	attempts?: number;
	retryDelayMs?: (attempt: number) => number;
}

export function getClaudeConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
	const configDir = env.CLAUDE_CONFIG_DIR?.trim();
	return configDir ? join(configDir, ".claude.json") : join(homedir(), ".claude.json");
}

function isProjectTrusted(config: ClaudeConfigFile, projectPath: string): boolean {
	return config.projects?.[projectPath]?.hasTrustDialogAccepted === true;
}

export async function isClaudeWorkspaceTrusted(
	directory: string,
	options: Pick<ClaudeWorkspaceTrustOptions, "configFilePath"> = {},
): Promise<boolean> {
	let config: ClaudeConfigFile;
	try {
		config = JSON.parse(
			await readFile(options.configFilePath ?? getClaudeConfigFilePath(), "utf8"),
		) as ClaudeConfigFile;
	} catch {
		return false;
	}
	const root = await resolveWorkspaceTrustRoot(directory);
	if (root.isGitRepository) {
		// A trusted parent of a git root does not count for Claude Code.
		return isProjectTrusted(config, root.path);
	}
	for (let current = root.path; ; current = dirname(current)) {
		if (isProjectTrusted(config, current)) {
			return true;
		}
		if (current === dirname(current)) {
			return false;
		}
	}
}

function defaultRetryDelayMs(attempt: number): number {
	return 150 + 100 * attempt;
}

// Sets projects[<main git root>].hasTrustDialogAccepted in ~/.claude.json. Every running Claude Code
// process rewrites that file, so this is a compare-and-swap: read it fresh, change one key, write a temp
// file, rename it over the original only if the original did not change meanwhile, then read it back.
// Calls in this process are serialised per file. A missing file is left alone (Claude Code creates it on
// first run, along with its onboarding state), and only git repositories are pre-trusted.
export async function ensureClaudeWorkspaceTrusted(
	directory: string,
	options: ClaudeWorkspaceTrustOptions = {},
): Promise<AgentWorkspaceTrustResult> {
	const configFilePath = options.configFilePath ?? getClaudeConfigFilePath();
	const attempts = options.attempts ?? DEFAULT_TRUST_WRITE_ATTEMPTS;
	const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
	const { trustRootPath, error } = await resolvePreTrustRoot(directory);
	if (error) {
		return { changed: false, trustRootPath, error };
	}
	let realConfigFilePath: string;
	try {
		realConfigFilePath = await realpath(configFilePath);
	} catch {
		return {
			changed: false,
			trustRootPath,
			error: `${configFilePath} does not exist (start Claude Code once first)`,
		};
	}
	return await withTrustConfigFileLock(realConfigFilePath, () =>
		writeClaudeProjectTrust(directory, trustRootPath, realConfigFilePath, attempts, retryDelayMs),
	);
}

async function writeClaudeProjectTrust(
	directory: string,
	trustRootPath: string,
	realConfigFilePath: string,
	attempts: number,
	retryDelayMs: (attempt: number) => number,
): Promise<AgentWorkspaceTrustResult> {
	let lastError = "";
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (attempt > 0) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs(attempt - 1)));
		}
		let before: Stats;
		let text: string;
		let config: ClaudeConfigFile;
		try {
			before = await stat(realConfigFilePath);
			text = await readFile(realConfigFilePath, "utf8");
			config = JSON.parse(text) as ClaudeConfigFile;
		} catch (error) {
			// Claude Code may be mid-write.
			lastError = `read: ${error instanceof Error ? error.message : String(error)}`;
			continue;
		}
		if (isProjectTrusted(config, trustRootPath)) {
			return { changed: false, trustRootPath };
		}
		const projects = config.projects ?? {};
		config.projects = {
			...projects,
			[trustRootPath]: { ...(projects[trustRootPath] ?? {}), hasTrustDialogAccepted: true },
		};
		const tempPath = `${realConfigFilePath}.kanban-${process.pid}-${randomUUID()}.tmp`;
		try {
			await writeFile(tempPath, JSON.stringify(config, null, 2), { mode: before.mode & 0o777 });
			const now = await stat(realConfigFilePath);
			if (
				now.mtimeMs !== before.mtimeMs ||
				now.size !== before.size ||
				(await readFile(realConfigFilePath, "utf8")) !== text
			) {
				lastError = "file changed while editing";
				continue;
			}
			await rename(tempPath, realConfigFilePath);
		} catch (error) {
			lastError = `write: ${error instanceof Error ? error.message : String(error)}`;
			continue;
		} finally {
			await rm(tempPath, { force: true }).catch(() => {
				// Best effort: a leftover temp file is harmless.
			});
		}
		if (await isClaudeWorkspaceTrusted(directory, { configFilePath: realConfigFilePath })) {
			return { changed: true, trustRootPath };
		}
		lastError = "not there on read-back (overwritten)";
	}
	return { changed: false, trustRootPath, error: lastError };
}
function normalizeTerminalText(input: string): string {
	return input.toLowerCase().replace(/\s+/gu, " ");
}

function stripAnsiAndControl(input: string): string {
	let output = "";
	let mode: "text" | "escape" | "csi" | "osc" | "osc_escape" = "text";
	for (const char of input) {
		if (mode === "text") {
			if (char === "\u001b") {
				mode = "escape";
				continue;
			}
			const code = char.charCodeAt(0);
			if ((code >= 32 && code !== 127) || char === "\n" || char === "\r" || char === "\t") {
				output += char;
			}
			continue;
		}
		if (mode === "escape") {
			if (char === "[") {
				mode = "csi";
				continue;
			}
			if (char === "]") {
				mode = "osc";
				continue;
			}
			mode = "text";
			continue;
		}
		if (mode === "csi") {
			const code = char.charCodeAt(0);
			if (code >= 64 && code <= 126) {
				mode = "text";
			}
			continue;
		}
		if (mode === "osc") {
			if (char === "\u0007") {
				mode = "text";
			} else if (char === "\u001b") {
				mode = "osc_escape";
			}
			continue;
		}
		if (mode === "osc_escape") {
			mode = char === "\\" ? "text" : "osc";
		}
	}
	return output;
}

export function hasClaudeWorkspaceTrustPrompt(text: string): boolean {
	const normalized = normalizeTerminalText(stripAnsiAndControl(text));
	return /yes,?\s*i\s*trust\s*this\s*folder/u.test(normalized) || /trust\s+this\s+folder/u.test(normalized);
}

// Which option the trust dialog's pointer is on in the latest render. Claude Code 2.1.291 lists
// "No, exit" first and focuses it, so a bare Enter exits the session (exit code 1).
function getClaudeWorkspaceTrustFocus(text: string): "trust" | "exit" | null {
	const normalized = normalizeTerminalText(stripAnsiAndControl(text));
	let focus: "trust" | "exit" | null = null;
	for (const match of normalized.matchAll(/[❯>]\s*(?:\d+\.\s*)?(yes|no)\b/gu)) {
		focus = match[1] === "yes" ? "trust" : "exit";
	}
	return focus;
}

// The key that moves the trust dialog toward "Yes, I trust this folder": Enter when it is focused,
// arrow down when "No" is, and nothing when the focus cannot be read (never risk choosing "No, exit").
export function getClaudeWorkspaceTrustConfirmInput(text: string): string | null {
	const focus = getClaudeWorkspaceTrustFocus(text);
	if (focus === "trust") {
		return "\r";
	}
	return focus === "exit" ? ARROW_DOWN : null;
}

function normalizeTrustPath(path: string): string {
	const normalized = `${path.replace(/\\/gu, "/").replace(/\/+$/u, "")}/`;
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isTaskWorktreePath(path: string): boolean {
	const normalizedPath = normalizeTrustPath(path);
	return getTaskWorktreeSearchRootPaths().some((root) => normalizedPath.startsWith(normalizeTrustPath(root)));
}

export function shouldAutoConfirmClaudeWorkspaceTrust(agentId: RuntimeAgentId, cwd: string): boolean {
	return agentId === "claude" && isTaskWorktreePath(cwd);
}

export function stopWorkspaceTrustTimers(state: { workspaceTrustConfirmTimer: NodeJS.Timeout | null }): void {
	if (state.workspaceTrustConfirmTimer) {
		clearTimeout(state.workspaceTrustConfirmTimer);
		state.workspaceTrustConfirmTimer = null;
	}
}
