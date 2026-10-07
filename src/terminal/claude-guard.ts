// `kanban hooks claude-guard`: the command guardrails of a Claude Code task card, run from the PreToolUse hook on
// Bash in the card's --settings file (agent-session-adapters.ts). Claude Code's own deny rules match the command
// text as written; this checks it with Kanban's matcher (command-patterns.ts), which also sees quoted, wrapped and
// `sh -c` forms and a PR card's own-branch push. A `deny` decision prevents the tool call in every permission mode.
import { describeDeniedCommand, findDeniedCommand } from "../guardrails/command-patterns";
import type { CommandGuardPolicy } from "./agent-guardrails";

/** The hook's stdout: a deny decision, or null to leave the call to Claude Code's permission flow. */
export interface ClaudeGuardOutput {
	hookSpecificOutput: {
		hookEventName: "PreToolUse";
		permissionDecision: "deny";
		permissionDecisionReason: string;
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function evaluateClaudeGuard(payload: unknown, policy: CommandGuardPolicy): ClaudeGuardOutput | null {
	const record = asRecord(payload);
	const command = asRecord(record?.tool_input)?.command;
	if (record?.tool_name !== "Bash" || typeof command !== "string") {
		return null;
	}
	const denied = findDeniedCommand(command, policy.deniedCommands);
	if (!denied) {
		return null;
	}
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: describeDeniedCommand(denied),
		},
	};
}
