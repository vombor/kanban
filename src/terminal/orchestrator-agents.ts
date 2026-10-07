// What the watchdog needs to know about each agent, kept with the other per-agent adapter knowledge so the watchdog
// itself (src/pipeline/watchdog/) never compares an agent id to a constant:
//
// - the headless runner for an orchestrator wake (`claude -p`, `codex exec`); an agent without one is woken in its
//   sidebar session instead (plan §2.3, bin/orchestrator-wake.mjs);
// - whether the agent fires a hook as soon as it takes its prompt, so "running since start with no hook" means it is
//   stuck on a startup dialog (lib/prompt-watch.cjs: Kanban hooks UserPromptSubmit for Claude Code and Codex);
// - its folder-trust state (claude-workspace-trust.ts, codex-workspace-trust.ts);
// - an interactive session of the agent that Kanban did not start (Claude Code transcripts), so a headless run is not
//   started beside a human's live session.
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { RUNTIME_AGENT_CATALOG } from "../core/agent-catalog";
import type { RuntimeAgentId } from "../core/api-contract";
import { isClaudeWorkspaceTrusted } from "./claude-workspace-trust";
import { getCodexWorkspaceTrustLevel } from "./codex-workspace-trust";

/** Written into every headless orchestrator prompt; a transcript that starts with it is not an interactive session. */
export const HEADLESS_ORCHESTRATOR_MARKER = "started headless by Kanban's watchdog";
/** The legacy kit's marker (bin/orchestrator-wake.mjs), for transcripts of runs it started. */
const LEGACY_HEADLESS_ORCHESTRATOR_MARKER = "started headless by the kit's monitors";

export interface HeadlessOrchestratorCommand {
	binary: string;
	args: string[];
}

export interface LiveInteractiveSession {
	id: string;
	ageSec: number;
}

interface OrchestratorAgentProfile {
	headless?: (prompt: string) => HeadlessOrchestratorCommand;
	/** The agent fires a hook when it takes its prompt (a start with no hook is a stuck start). */
	hooksOnPromptSubmit?: boolean;
	trusted?: (directory: string) => Promise<boolean | null>;
	liveInteractiveSession?: (
		projectPath: string,
		options: { liveMs: number; now: number; homeDir: string },
	) => Promise<LiveInteractiveSession | null>;
}

/** Claude Code keeps a transcript per session in `~/.claude/projects/<project path with every non-alphanumeric as ->`. */
async function findLiveClaudeTranscript(
	projectPath: string,
	options: { liveMs: number; now: number; homeDir: string },
): Promise<LiveInteractiveSession | null> {
	const dir = join(options.homeDir, ".claude", "projects", projectPath.replace(/[^A-Za-z0-9]/gu, "-"));
	let names: string[];
	try {
		names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return null;
	}
	for (const name of names) {
		const path = join(dir, name);
		const stats = await stat(path).catch(() => null);
		const age = stats ? options.now - stats.mtimeMs : Number.POSITIVE_INFINITY;
		if (age > options.liveMs) {
			continue;
		}
		const file = await open(path, "r").catch(() => null);
		if (!file) {
			continue;
		}
		try {
			const buffer = Buffer.alloc(4096);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			const head = buffer.subarray(0, bytesRead).toString("utf8");
			if (!head.includes(HEADLESS_ORCHESTRATOR_MARKER) && !head.includes(LEGACY_HEADLESS_ORCHESTRATOR_MARKER)) {
				return { id: name.slice(0, 8), ageSec: Math.round(age / 1000) };
			}
		} finally {
			await file.close();
		}
	}
	return null;
}

const PROFILES: Partial<Record<RuntimeAgentId, OrchestratorAgentProfile>> = {
	// Ported from archive/devteam-kit:bin/orchestrator-wake.mjs@6da71597 (runOnce: `claude -p … --permission-mode auto`)
	// and kit main cc1eefe (no headless run while an interactive Claude session in the project is live).
	claude: {
		headless: (prompt) => ({
			binary: "claude",
			args: ["-p", prompt, "--permission-mode", "auto", "--output-format", "text"],
		}),
		hooksOnPromptSubmit: true,
		trusted: async (directory) => await isClaudeWorkspaceTrusted(directory),
		liveInteractiveSession: findLiveClaudeTranscript,
	},
	codex: {
		headless: (prompt) => ({
			binary: "codex",
			args: ["exec", "--dangerously-bypass-approvals-and-sandbox", prompt],
		}),
		hooksOnPromptSubmit: true,
		trusted: async (directory) => {
			const level = await getCodexWorkspaceTrustLevel(directory);
			return level === null ? null : level === "trusted";
		},
	},
};

export function getAgentLabel(agentId: RuntimeAgentId): string {
	return RUNTIME_AGENT_CATALOG.find((entry) => entry.id === agentId)?.label ?? agentId;
}

/** The headless orchestrator command for the agent, or null when it has no headless runner (wake its sidebar). */
export function getHeadlessOrchestratorCommand(
	agentId: RuntimeAgentId,
	prompt: string,
): HeadlessOrchestratorCommand | null {
	return PROFILES[agentId]?.headless?.(prompt) ?? null;
}

export function hasHeadlessOrchestratorRunner(agentId: RuntimeAgentId): boolean {
	return Boolean(PROFILES[agentId]?.headless);
}

export function agentHooksOnPromptSubmit(agentId: RuntimeAgentId): boolean {
	return PROFILES[agentId]?.hooksOnPromptSubmit === true;
}

/** True/false when the agent has a trust setting for the folder, null when unknown or not applicable. */
export async function isAgentWorkspaceTrusted(agentId: RuntimeAgentId, directory: string): Promise<boolean | null> {
	const trusted = PROFILES[agentId]?.trusted;
	return trusted ? await trusted(directory).catch(() => null) : null;
}

/** An interactive session of the agent in the project that Kanban's sidebar summary may not show, or null. */
export async function findLiveInteractiveSession(
	agentId: RuntimeAgentId,
	projectPath: string,
	options: { liveMs: number; now?: number; homeDir?: string },
): Promise<LiveInteractiveSession | null> {
	const probe = PROFILES[agentId]?.liveInteractiveSession;
	if (!probe || options.liveMs <= 0) {
		return null;
	}
	return await probe(projectPath, {
		liveMs: options.liveMs,
		now: options.now ?? Date.now(),
		homeDir: options.homeDir ?? homedir(),
	});
}
