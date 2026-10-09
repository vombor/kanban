// What an agent's own files say about a run, for runners that watch cards they started (the team kit's calibration
// runner): whether the session is running when Kanban has no summary, a tool-call loop, tool calls written as text,
// whether a turn ever started, whether the model rejected an image, and whether the agent is signed in. Each fact is per agent, so it lives here (the
// incident gate forbids agent-id literals in src/kits and src/pipeline); an agent without a profile entry answers
// null ("can't tell"), and the caller then decides on Kanban's own state alone.
//
// Ported from archive/devteam-kit:lib/cline-session.cjs@9828540 (latest, repeats, toolUse) and
// lib/copilot-session.cjs@9828540 (signedIn, latestForCard), as used by qa/calibrate.mjs@94247a7.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeAgentId } from "../core/api-contract";
import { findCopilotSessionIdForCwd, getCopilotHomePath, parseCopilotConfig } from "./agent-session-adapters";
import { type ClineSessionFileReader, createClineSessionFileReader, getClineSessionsPath } from "./cline-session-files";
import { type ClineImageRejection, getClineImageRejection } from "./cline-turn-outcome";

/** The same tool call (name + input) filling `count` of the last `of` calls of the newest session. */
export interface ToolCallLoop {
	count: number;
	of: number;
	call: string;
}

/** Native tool calls vs. tool calls written as plain text, over the newest session's assistant turns. */
export interface ToolUseCounts {
	native: number;
	textual: number;
	turns: number;
}

export interface AgentRunSignals {
	/** The agent's own session file says "running" (for a card Kanban has no summary of). */
	isSessionRunning: (agentId: RuntimeAgentId, workspacePath: string) => Promise<boolean | null>;
	findToolCallLoop: (agentId: RuntimeAgentId, workspacePath: string, last?: number) => Promise<ToolCallLoop | null>;
	countToolUse: (agentId: RuntimeAgentId, workspacePath: string) => Promise<ToolUseCounts | null>;
	/** The newest session's last reply is the model's "no images" rejection (the image stays in its history). */
	/** The image rejection the run's last reply is (findEndingImageRejection), false for none, null when unreadable. */
	hasImageRejection: (agentId: RuntimeAgentId, workspacePath: string) => Promise<ClineImageRejection | false | null>;
	/** Whether the agent ever started a turn in this worktree (it wrote its event log). */
	hasStartedTurn: (agentId: RuntimeAgentId, workspacePath: string) => Promise<boolean | null>;
	/** Whether the agent has a login it can start a run with. */
	isSignedIn: (agentId: RuntimeAgentId, env?: NodeJS.ProcessEnv) => Promise<boolean | null>;
}

interface ToolUseBlock {
	type?: unknown;
	name?: unknown;
	input?: unknown;
	text?: unknown;
}

function contentBlocks(message: unknown): ToolUseBlock[] {
	const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
	if (Array.isArray(content)) {
		return content.filter((block): block is ToolUseBlock => Boolean(block) && typeof block === "object");
	}
	return [{ type: "text", text: String(content ?? "") }];
}

function roleOf(message: unknown): unknown {
	return message && typeof message === "object" ? (message as { role?: unknown }).role : undefined;
}

// Nova 2 Lite QA (calibration v5, 10/06) re-ran `npx ts-node server.ts &` 334 times in 75 min ($64.84, 215M input
// tokens) and flipped one CSS line 200 times.
export function findRepeatedToolCall(messages: readonly unknown[], last = 60): ToolCallLoop | null {
	const calls: string[] = [];
	for (const message of messages) {
		for (const block of contentBlocks(message)) {
			if (block.type === "tool_use") {
				calls.push(`${String(block.name)} ${JSON.stringify(block.input)}`);
			}
		}
	}
	const tail = calls.slice(-last);
	const counts = new Map<string, number>();
	let best: string | null = null;
	for (const call of tail) {
		const count = (counts.get(call) ?? 0) + 1;
		counts.set(call, count);
		if (best === null || count > (counts.get(best) ?? 0)) {
			best = call;
		}
	}
	return best === null ? null : { count: counts.get(best) ?? 0, of: tail.length, call: best.slice(0, 160) };
}

// Devstral-Small on Lemonade (calibration v11, 10/06) answered every turn with "<run_commands>..." text: llama.cpp
// served it without a tool-call template, so Cline ran nothing in 3 runs x 7 turns.
const TEXT_TOOL_CALL =
	/<(run_commands|execute_command|read_files?|write_to_file|replace_in_file|editor|search_files|list_files)>/u;

export function countToolUse(messages: readonly unknown[]): ToolUseCounts {
	let native = 0;
	let textual = 0;
	let turns = 0;
	for (const message of messages) {
		if (roleOf(message) !== "assistant") {
			continue;
		}
		turns += 1;
		for (const block of contentBlocks(message)) {
			if (block.type === "tool_use") {
				native += 1;
			} else if (block.type === "text" && TEXT_TOOL_CALL.test(typeof block.text === "string" ? block.text : "")) {
				textual += 1;
			}
		}
	}
	return { native, textual, turns };
}

/**
 * The image rejection ("model doesn't support images", or an image over the size limits) that the last assistant
 * reply is, with no tool call, or null: the text the pipeline's recovery reads too (getClineImageRejection). Every
 * later request of that conversation fails the same way.
 */
export function findEndingImageRejection(messages: readonly unknown[]): ClineImageRejection | null {
	const last = messages.filter((message) => roleOf(message) === "assistant").at(-1);
	if (!last) {
		return null;
	}
	const blocks = contentBlocks(last);
	if (blocks.some((block) => block.type === "tool_use")) {
		return null;
	}
	const text = blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
	return getClineImageRejection(text);
}

function hasEntries(value: unknown): boolean {
	return Array.isArray(value)
		? value.length > 0
		: Boolean(value) && typeof value === "object" && Object.keys(value as object).length > 0;
}

// 60c5538: don't start a Copilot run signed out (Kanban's Copilot trust write once wiped the login from config.json,
// 10/06 19:58Z). Copilot keeps the login in its JSONC config.json (authTokens / loggedInUsers). This reads only
// the login; a run is also signed in through COPILOT_GITHUB_TOKEN (isCopilotRunSignedIn).
export async function isCopilotSignedIn(): Promise<boolean> {
	let content: string;
	try {
		content = await readFile(join(getCopilotHomePath(), "config.json"), "utf8");
	} catch {
		return false;
	}
	const config = parseCopilotConfig(content)?.config;
	return Boolean(config) && (hasEntries(config?.authTokens) || hasEntries(config?.loggedInUsers));
}

// Copilot launches keep Kanban's env (copilotAdapter), and COPILOT_GITHUB_TOKEN is Copilot's own token. GH_TOKEN and
// GITHUB_TOKEN don't count: in the container they hold the user's gh/git PAT, not a Copilot login.
async function isCopilotRunSignedIn(env: NodeJS.ProcessEnv): Promise<boolean> {
	return Boolean(env.COPILOT_GITHUB_TOKEN?.trim()) || (await isCopilotSignedIn());
}

// de83bf8: a signed-out Copilot CLI never writes events.jsonl and spins in its TUI (v9 mai-flash 10/06: 3 x 60 min DNF).
async function hasCopilotEvents(workspacePath: string): Promise<boolean> {
	const sessionId = await findCopilotSessionIdForCwd(workspacePath);
	if (!sessionId) {
		return false;
	}
	return await stat(join(getCopilotHomePath(), "session-state", sessionId, "events.jsonl")).then(
		() => true,
		() => false,
	);
}

interface AgentRunSignalProfile {
	readMessages?: (workspacePath: string) => Promise<unknown[] | null>;
	readStatus?: (workspacePath: string) => Promise<string | null>;
	hasStartedTurn?: (workspacePath: string) => Promise<boolean>;
	isSignedIn?: (env: NodeJS.ProcessEnv) => Promise<boolean>;
}

export function createAgentRunSignals(
	deps: { clineReader?: ClineSessionFileReader; clineSessionsPath?: string } = {},
): AgentRunSignals {
	const clineReader = deps.clineReader ?? createClineSessionFileReader();
	const clineSessionsPath = () => deps.clineSessionsPath ?? getClineSessionsPath();
	const profiles: Partial<Record<RuntimeAgentId, AgentRunSignalProfile>> = {
		cline: {
			readMessages: async (workspacePath) =>
				await clineReader.readLatestSessionMessages(clineSessionsPath(), workspacePath),
			readStatus: async (workspacePath) =>
				(await clineReader.readLatestSession(clineSessionsPath(), workspacePath))?.status ?? null,
		},
		copilot: {
			hasStartedTurn: hasCopilotEvents,
			isSignedIn: isCopilotRunSignedIn,
		},
	};

	const readMessages = async (agentId: RuntimeAgentId, workspacePath: string) =>
		(await profiles[agentId]?.readMessages?.(workspacePath)) ?? null;

	return {
		isSessionRunning: async (agentId, workspacePath) => {
			const readStatus = profiles[agentId]?.readStatus;
			if (!readStatus) {
				return null;
			}
			const status = await readStatus(workspacePath);
			return status === null ? null : status === "running";
		},
		findToolCallLoop: async (agentId, workspacePath, last) => {
			const messages = await readMessages(agentId, workspacePath);
			return messages ? findRepeatedToolCall(messages, last) : null;
		},
		countToolUse: async (agentId, workspacePath) => {
			const messages = await readMessages(agentId, workspacePath);
			return messages ? countToolUse(messages) : null;
		},
		hasImageRejection: async (agentId, workspacePath) => {
			const messages = await readMessages(agentId, workspacePath);
			return messages ? (findEndingImageRejection(messages) ?? false) : null;
		},
		hasStartedTurn: async (agentId, workspacePath) =>
			(await profiles[agentId]?.hasStartedTurn?.(workspacePath)) ?? null,
		isSignedIn: async (agentId, env = process.env) => (await profiles[agentId]?.isSignedIn?.(env)) ?? null,
	};
}
