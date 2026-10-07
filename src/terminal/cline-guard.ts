// `kanban hooks cline-guard`: the task-card guardrails for the Cline CLI, run from Kanban's PreToolUse hook script in
// the card's worktree (agent-session-adapters.ts). Cline has no command deny list, but a PreToolUse hook that prints
// `{"cancel": true, "errorMessage": …}` stops the tool call before it runs (see agent-guardrails.ts). The hook
// payload carries the raw tool input as `tool_call.input` and a string-valued copy as `preToolUse.parameters`.
import { isAbsolute, resolve } from "node:path";

import { findDeniedCommand } from "../guardrails/command-patterns";
import { isPathInside } from "../guardrails/task-guardrails";
import type { ClineGuardPolicy } from "./agent-guardrails";

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

export function evaluateClineGuard(payload: unknown, policy: ClineGuardPolicy): ClineGuardDecision {
	const call = readToolCall(payload);
	if (!call) {
		return ALLOW;
	}
	if (call.toolName === "run_commands") {
		for (const line of listCommandLines(call.input)) {
			const denied = findDeniedCommand(line, policy.deniedCommands);
			if (denied) {
				return {
					cancel: true,
					errorMessage: `Blocked by Kanban's task-card guardrails: \`${denied.command}\` matches "${denied.rule.pattern}". Task cards never push, rewrite shared branches or restart services; leave that to the orchestrator.`,
				};
			}
		}
		return ALLOW;
	}
	if (!policy.confineWrites) {
		return ALLOW;
	}
	for (const path of listWritePaths(call.toolName, call.input)) {
		const absolute = isAbsolute(path) ? path : resolve(policy.worktreePath, path);
		if (!policy.writableRoots.some((root) => isPathInside(root, absolute))) {
			return {
				cancel: true,
				errorMessage: `Blocked by Kanban's task-card guardrails: ${absolute} is outside this card's worktree ${policy.worktreePath}. Write only inside the worktree (or a temp dir).`,
			};
		}
	}
	return ALLOW;
}
