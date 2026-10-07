// `kanban hooks cline-guard`: the task-card guardrails for the Cline CLI, run from Kanban's PreToolUse hook script in
// the card's worktree (agent-session-adapters.ts). Cline has no command deny list, but a PreToolUse hook that prints
// `{"cancel": true, "errorMessage": …}` stops the tool call before it runs (see agent-guardrails.ts). The hook
// payload carries the raw tool input as `tool_call.input` and a string-valued copy as `preToolUse.parameters`.
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
	describeDeniedCommand,
	describeDeniedPath,
	findDeniedCommand,
	findDeniedPathInCommand,
	findProtectedFileWrite,
} from "../guardrails/command-patterns";
import { isPathInside } from "../guardrails/task-guardrails";
import type { ClineGuardPolicy } from "./agent-guardrails";
import { checkClineHookWorkspaceRoot } from "./cline-hook-identity";

export interface ClineGuardDecision {
	cancel: boolean;
	errorMessage?: string;
}

const ALLOW: ClineGuardDecision = { cancel: false };

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
		return value;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function quoteWord(word: string): string {
	return /^[\w./:@%+=,-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** The command lines of a `run_commands` input (`commands`: strings or `{ command, args }`). */
function listCommandLines(input: Record<string, unknown>): string[] {
	const commands = parseMaybeJson(input.commands ?? input.command);
	const entries = Array.isArray(commands) ? commands : [commands];
	const lines: string[] = [];
	for (const entry of entries) {
		if (typeof entry === "string") {
			lines.push(entry);
			continue;
		}
		const structured = asRecord(entry);
		if (structured && typeof structured.command === "string") {
			const args = Array.isArray(structured.args) ? structured.args.filter((arg) => typeof arg === "string") : [];
			lines.push([structured.command, ...args.map(quoteWord)].join(" "));
		}
	}
	return lines;
}

/** The files an `apply_patch` input touches (`*** Add/Update/Delete File:` and `*** Move to:` headers). */
export function listPatchPaths(patch: string): string[] {
	const paths: string[] = [];
	for (const line of patch.split("\n")) {
		const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/u.exec(line.trim());
		if (match?.[1]) {
			paths.push(match[1].trim());
		}
	}
	return paths;
}

function listWritePaths(toolName: string, input: Record<string, unknown>): string[] {
	if (toolName === "editor") {
		return typeof input.path === "string" ? [input.path] : [];
	}
	if (toolName === "apply_patch") {
		const patch = typeof input.input === "string" ? input.input : typeof input.patch === "string" ? input.patch : "";
		return listPatchPaths(patch);
	}
	return [];
}

/** The files a `read_files` input names: `files[].path`, a bare string or list, `{ path }` or `{ file_path }`. */
export function listReadPaths(input: unknown): string[] {
	const value = parseMaybeJson(input);
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap((entry) => listReadPaths(entry));
	}
	const record = asRecord(value);
	if (!record) {
		return [];
	}
	if (record.files !== undefined) {
		return listReadPaths(record.files);
	}
	const path = typeof record.path === "string" ? record.path : record.file_path;
	return typeof path === "string" ? [path] : [];
}

function readToolCall(payload: unknown): { toolName: string; input: Record<string, unknown> } | null {
	const record = asRecord(payload);
	const toolCall = asRecord(record?.tool_call);
	const preToolUse = asRecord(record?.preToolUse);
	const toolName =
		typeof toolCall?.name === "string"
			? toolCall.name
			: typeof preToolUse?.toolName === "string"
				? preToolUse.toolName
				: null;
	if (!toolName) {
		return null;
	}
	const rawInput = asRecord(toolCall?.input) ?? asRecord(parseMaybeJson(toolCall?.input));
	const input = rawInput ?? asRecord(preToolUse?.parameters) ?? {};
	return { toolName, input };
}

/** A path's resolved form: the realpath of its nearest existing ancestor, plus the rest (the file may not exist yet). */
function resolveExistingPrefix(path: string): string {
	const missing: string[] = [];
	let current = path;
	for (;;) {
		try {
			return join(realpathSync(current), ...missing.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				return path;
			}
			missing.push(basename(current));
			current = parent;
		}
	}
}

/**
 * Whether a write to `path` stays inside a writable root. The decision is on where the write really lands (a
 * symlink in the worktree that points at the main checkout is outside), compared with each root as configured and
 * as resolved, so a root or path reached through a symlinked parent (`/projects` → `/mnt/projects`) still matches.
 */
export function isWritablePath(path: string, roots: readonly string[]): boolean {
	const resolved = resolveExistingPrefix(path);
	return roots.some((root) => isPathInside(root, resolved) || isPathInside(resolveExistingPrefix(root), resolved));
}

export function evaluateClineGuard(payload: unknown, policy: ClineGuardPolicy): ClineGuardDecision {
	// The policy is the card's whose worktree it names: a session in another worktree is refused, never judged by it.
	const identityError = checkClineHookWorkspaceRoot(payload, policy.worktreePath);
	if (identityError) {
		return { cancel: true, errorMessage: `Blocked by Kanban's task-card guardrails: ${identityError}` };
	}
	const call = readToolCall(payload);
	if (!call) {
		return ALLOW;
	}
	if (call.toolName === "run_commands") {
		for (const line of listCommandLines(call.input)) {
			const denied = findDeniedCommand(line, policy.deniedCommands);
			if (denied) {
				return { cancel: true, errorMessage: describeDeniedCommand(denied) };
			}
			const cwd = policy.cwd ?? policy.worktreePath;
			const deniedPath =
				findDeniedPathInCommand(line, policy.deniedPathRoots ?? [], cwd) ??
				findProtectedFileWrite(line, policy.protectedWriteRoots ?? [], cwd);
			if (deniedPath) {
				return { cancel: true, errorMessage: describeDeniedPath(deniedPath) };
			}
		}
		return ALLOW;
	}
	const toAbsolute = (path: string) => (isAbsolute(path) ? path : resolve(policy.worktreePath, path));
	if (call.toolName === "read_files") {
		const deniedReadRoots = policy.deniedReadRoots ?? [];
		for (const path of listReadPaths(call.input)) {
			if (deniedReadRoots.length > 0 && isWritablePath(toAbsolute(path), deniedReadRoots)) {
				return { cancel: true, errorMessage: describeDeniedPath(path) };
			}
		}
		return ALLOW;
	}
	const writePaths = listWritePaths(call.toolName, call.input);
	const deniedWriteRoots = policy.deniedWriteRoots ?? [];
	for (const path of writePaths) {
		if (deniedWriteRoots.length > 0 && isWritablePath(toAbsolute(path), deniedWriteRoots)) {
			return { cancel: true, errorMessage: describeDeniedPath(path) };
		}
	}
	if (!policy.confineWrites) {
		return ALLOW;
	}
	for (const path of writePaths) {
		const absolute = toAbsolute(path);
		if (!isWritablePath(absolute, policy.writableRoots)) {
			return {
				cancel: true,
				errorMessage: `Blocked by Kanban's task-card guardrails: ${absolute} is outside this card's worktree ${policy.worktreePath}. Write only inside the worktree (or a temp dir).`,
			};
		}
	}
	return ALLOW;
}
