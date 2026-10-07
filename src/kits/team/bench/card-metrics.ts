// Card metrics for the team kit's scoreboard (`bench` feature): who built a card (agent/provider/model) and what it
// cost. `kanban bench metrics <id>` prints them; the scoreboard feature and `kanban bench record-verdict` put them on
// each scoreboard line.
//
//  - Per QA round: provider/model is the dominant one in the sessions started after the card's previous review
//    snapshot (a rework round; "attribution":"round", "roundModels"), else over all sessions ("attribution":"all").
//    Metrics stay cumulative.
//  - The model comes from the agent's own session files (Cline: modelInfo on assistant messages, else the session
//    .json; Codex: turn_context), NOT the board: board settings get edited after the work is done. The board's
//    settings are the fallback ("modelSource":"board").
//  - Wall time = first session start → the card's latest "review" snapshot of refs/kanban/snapshots/<id> (commit
//    time). With `at`, the latest review snapshot at or before that time is used (backfilling older QA rounds). Only
//    sessions started before the end point are counted, so metrics are cumulative up to the reviewed snapshot.
//    activeMin = the counted sessions' own durations (excludes time a card sat idle before the snapshot).
//  - costUSD prices each turn with the price table (prices.ts), cache reads/writes separately. null if any turn used
//    a model with no known price. costUSDNoCache = the old all-input-at-full-price upper bound.
//  - Turns are de-duplicated by message id across sessions (a resumed Cline session copies the earlier session's
//    messages), and the empty trailing assistant message that carries the session's CUMULATIVE totals is skipped.
//    Before 2026-10-05 both were double counted.
//  - The agent is the one the card actually ran on (its session files), else the card's agent, else the agent
//    selected in Kanban settings: the effective agent, never the literal `card.agentId` alone (plan §4.0).
//
// Ported from archive/devteam-kit:bench/card-metrics.cjs@760fd36c (Codex rollouts from @d0068467).
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { RuntimeAgentId } from "../../../core/api-contract";
import { createGitProcessEnv } from "../../../core/git-process-env";
import { type PriceTable, type TurnTokens, turnCost, turnCostNoCache } from "./prices";

const execFileAsync = promisify(execFile);

const CLI_SESSION_DIR = /^\d+_[a-z0-9]+$/iu;
const CODEX_ROLLOUT_FILE = /^rollout-.*\.jsonl$/u;
const CODEX_WALK_DEPTH = 3; // <sessions>/YYYY/MM/DD/rollout-*.jsonl
const CODEX_HEAD_BYTES = 8192;
const CODEX_TOOL_ERROR = /Process exited with code [1-9]|"exit_code":\s*[1-9]/u;
const CUMULATIVE_TOTALS_RATIO = 0.99;

/** The card fields metrics read; a live board card or a card from a board backup. */
export interface CardMetricsCard {
	id: string;
	title: string | null;
	agentId: RuntimeAgentId | null;
	providerId: string | null;
	modelId: string | null;
	column: string | null;
}

export interface ReviewSnapshot {
	sha: string;
	/** Commit time, epoch ms. */
	ms: number;
	reason?: string;
}

export interface CardMetricsSources {
	clineSessionsPath: string;
	codexSessionsPath: string;
	/** Task worktree roots (`<root>/<taskId>/<repo>`): a session whose cwd is under one belongs to that task. */
	worktreeRoots: string[];
	prices: PriceTable;
	/** The card's review snapshots, newest first (readReviewSnapshots on its repo). */
	readSnapshots: (taskId: string, atMs: number | null) => Promise<ReviewSnapshot[]>;
}

export interface CardMetricsInput {
	taskId: string;
	card: CardMetricsCard | null;
	/** ISO time: measure up to the latest review snapshot at or before it. */
	at?: string | null;
	/** Kanban's selected agent, for a card that names none and left no session files. */
	selectedAgentId?: RuntimeAgentId | null;
}

export interface CardMetricsTotals {
	wallMin: number | null;
	activeMin: number | null;
	sessions: number;
	assistantTurns: number;
	toolCalls: number;
	toolErrors: number;
	tokensIn: number;
	tokensOut: number;
	tokensCacheRead: number;
	tokensCacheWrite: number;
	costUSD: number | null;
	costUSDNoCache: number | null;
}

export interface CardMetrics {
	devId: string;
	title: string | null;
	agent: RuntimeAgentId | null;
	column: string | null;
	provider: string | null;
	model: string | null;
	modelSource: "session" | "board";
	attribution: "round" | "all";
	roundSince: string | null;
	models: Record<string, number>;
	roundModels: Record<string, number>;
	boardModel: string | null;
	metrics: CardMetricsTotals;
	wall: { start: string | null; end: string | null; endSource: string | null };
	sessionStatuses: Record<string, number>;
}

interface ClineSessionMeta {
	status?: string;
	started_at?: string;
	ended_at?: string;
	model?: string;
	provider?: string;
	cwd?: string;
	workspace_root?: string;
	metadata?: { title?: string };
}

interface ClineMessage {
	id?: string;
	role?: string;
	content?: unknown;
	modelInfo?: { provider?: string; id?: string };
	metrics?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

interface ClineSession {
	dir: string;
	meta: ClineSessionMeta;
	startMs: number;
}

interface CodexSession {
	startMs: number;
	endMs: number;
	model: string | null;
	turns: TurnTokens[];
	toolCalls: number;
	toolErrors: number;
}

async function readJson<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return null;
	}
}

const roundTenth = (value: number): number => Math.round(value * 10) / 10;
const roundCents = (value: number): number => Math.round(value * 100) / 100;
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** True when `path` is the task's worktree or inside it: `<root>/<taskId>/…` for a known root, or any `/worktrees/<taskId>/`. */
export function isTaskWorktreePath(path: string, taskId: string, worktreeRoots: string[]): boolean {
	if (!path) {
		return false;
	}
	const target = resolve(path);
	for (const root of worktreeRoots) {
		const rel = relative(resolve(root), target);
		if (rel && !rel.startsWith("..") && rel.split(sep)[0] === taskId) {
			return true;
		}
	}
	// The legacy kit's rule (cline-session.cjs): any worktrees dir, so a root moved since still matches.
	return new RegExp(`[\\\\/]worktrees[\\\\/]${escapeRegExp(taskId)}([\\\\/]|$)`, "u").test(target);
}

/** The task's Cline session dirs: embedded-agent "<id>-…" dirs, and cline 3.x dirs whose cwd is the task's worktree. */
async function clineSessionDirs(sessionsPath: string, taskId: string, worktreeRoots: string[]): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(sessionsPath);
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const name of names) {
		if (name.startsWith(`${taskId}-`)) {
			dirs.push(name);
			continue;
		}
		if (!CLI_SESSION_DIR.test(name)) {
			continue;
		}
		const meta = await readJson<ClineSessionMeta>(join(sessionsPath, name, `${name}.json`));
		const paths = [meta?.workspace_root, meta?.cwd].filter((value): value is string => typeof value === "string");
		if (paths.some((path) => isTaskWorktreePath(path, taskId, worktreeRoots))) {
			dirs.push(name);
		}
	}
	return dirs;
}

async function loadClineSessions(
	sessionsPath: string,
	taskId: string,
	worktreeRoots: string[],
	endMs: number | null,
): Promise<ClineSession[]> {
	const sessions: ClineSession[] = [];
	for (const dir of await clineSessionDirs(sessionsPath, taskId, worktreeRoots)) {
		const meta = (await readJson<ClineSessionMeta>(join(sessionsPath, dir, `${dir}.json`))) ?? {};
		let startMs = Date.parse(meta.started_at ?? "");
		if (!Number.isFinite(startMs)) {
			const info = await stat(join(sessionsPath, dir)).catch(() => null);
			startMs = info ? info.birthtimeMs || info.mtimeMs : 0;
		}
		if (endMs === null || startMs <= endMs) {
			sessions.push({ dir, meta, startMs });
		}
	}
	return sessions.sort((a, b) => a.startMs - b.startMs);
}

async function listCodexRollouts(root: string): Promise<string[]> {
	const files: string[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory() && depth < CODEX_WALK_DEPTH) {
				await walk(path, depth + 1);
			} else if (entry.isFile() && CODEX_ROLLOUT_FILE.test(entry.name)) {
				files.push(path);
			}
		}
	};
	await walk(root, 0);
	return files;
}

async function readHead(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(CODEX_HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, bytesRead);
	} finally {
		await handle.close();
	}
}

// Codex cards (QA) have no Cline session files. Their rollouts start with a session_meta whose cwd is the card's
// worktree. Tokens come from token_count events: each change of total_token_usage adds that turn's
// last_token_usage (input_tokens INCLUDE cached_input_tokens = cache reads and cache_write_input_tokens). The model
// comes from turn_context.
async function loadCodexSessions(
	root: string,
	taskId: string,
	worktreeRoots: string[],
	endMs: number | null,
): Promise<CodexSession[]> {
	const sessions: CodexSession[] = [];
	for (const file of await listCodexRollouts(root)) {
		const head = await readHead(file).catch(() => "");
		const cwd = /"cwd":"([^"]*)"/u.exec(head)?.[1] ?? "";
		if (!isTaskWorktreePath(cwd, taskId, worktreeRoots)) {
			continue;
		}
		const text = await readFile(file, "utf8").catch(() => "");
		const session: CodexSession = { startMs: 0, endMs: 0, model: null, turns: [], toolCalls: 0, toolErrors: 0 };
		let lastTotal: unknown = null;
		for (const line of text.split("\n")) {
			let record: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
			try {
				record = JSON.parse(line) as typeof record;
			} catch {
				continue;
			}
			const time = Date.parse(record.timestamp ?? "");
			if (endMs !== null && time > endMs) {
				break;
			}
			if (Number.isFinite(time)) {
				session.startMs ||= time;
				session.endMs = time;
			}
			const payload = record.payload ?? {};
			if (record.type === "turn_context" && typeof payload.model === "string") {
				session.model = payload.model;
			}
			if (payload.type === "function_call") {
				session.toolCalls += 1;
			}
			if (payload.type === "function_call_output" && CODEX_TOOL_ERROR.test(JSON.stringify(payload.output ?? ""))) {
				session.toolErrors += 1;
			}
			const info = payload.info as
				| { total_token_usage?: { total_tokens?: unknown }; last_token_usage?: Record<string, number> }
				| undefined;
			if (payload.type === "token_count" && info?.total_token_usage) {
				const total = info.total_token_usage.total_tokens;
				if (total === lastTotal) {
					continue;
				}
				lastTotal = total;
				const usage = info.last_token_usage ?? {};
				session.turns.push({
					input: usage.input_tokens || 0,
					output: usage.output_tokens || 0,
					cacheRead: usage.cached_input_tokens || 0,
					cacheWrite: usage.cache_write_input_tokens || 0,
				});
			}
		}
		if (session.startMs) {
			sessions.push(session);
		}
	}
	return sessions.sort((a, b) => a.startMs - b.startMs);
}

/**
 * The card's review snapshots (`refs/kanban/snapshots/<id>` reflog entries whose reason says "review"), newest first;
 * every reflog entry when none says so; the ref itself when it has no reflog.
 */
export async function readReviewSnapshots(
	repoPath: string,
	taskId: string,
	atMs: number | null,
): Promise<ReviewSnapshot[]> {
	const git = async (...args: string[]): Promise<string> => {
		try {
			const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
				encoding: "utf8",
				env: createGitProcessEnv(),
			});
			return stdout.trim();
		} catch {
			return "";
		}
	};
	const ref = `refs/kanban/snapshots/${taskId}`;
	let candidates: ReviewSnapshot[] = (await git("reflog", "show", "--format=%H %ct %gs", ref))
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha = "", commitTime = "0", ...reason] = line.split(" ");
			return { sha, ms: Number(commitTime) * 1000, reason: reason.join(" ") };
		});
	const reviews = candidates.filter((candidate) => /review/u.test(candidate.reason ?? ""));
	if (reviews.length) {
		candidates = reviews;
	}
	if (!candidates.length) {
		const sha = await git("rev-parse", "-q", "--verify", ref);
		if (sha) {
			candidates = [{ sha, ms: Number(await git("show", "-s", "--format=%ct", sha)) * 1000 }];
		}
	}
	if (atMs !== null) {
		candidates = candidates.filter((candidate) => candidate.ms <= atMs);
	}
	return candidates.sort((a, b) => b.ms - a.ms);
}

const isEmptyContent = (content: unknown): boolean => !Array.isArray(content) || content.length === 0;

export async function computeCardMetrics(input: CardMetricsInput, sources: CardMetricsSources): Promise<CardMetrics> {
	const { card } = input;
	const id = card?.id ?? input.taskId;
	const atMs = input.at ? Date.parse(input.at) : null;
	if (atMs !== null && !Number.isFinite(atMs)) {
		throw new Error(`--at ${input.at} is not a date`);
	}
	const snapshots = await sources.readSnapshots(id, atMs);
	const snapshot = snapshots[0] ?? null;
	const previousSnapshot = snapshot
		? (snapshots.find((candidate) => candidate.sha !== snapshot.sha && candidate.ms < snapshot.ms) ?? null)
		: null;
	const endMs = snapshot?.ms ?? atMs ?? null;
	const inRound = (startMs: number): boolean => !previousSnapshot || startMs > previousSnapshot.ms;

	const sessions = await loadClineSessions(sources.clineSessionsPath, id, sources.worktreeRoots, endMs);
	const totals = {
		assistantTurns: 0,
		toolCalls: 0,
		toolErrors: 0,
		tokensIn: 0,
		tokensOut: 0,
		tokensCacheRead: 0,
		tokensCacheWrite: 0,
	};
	const models: Record<string, number> = {};
	const roundModels: Record<string, number> = {};
	const statuses: Record<string, number> = {};
	const count = (record: Record<string, number>, key: string): void => {
		record[key] = (record[key] ?? 0) + 1;
	};
	let cost = 0;
	let costNoCache = 0;
	let unpriced = false;
	let lastEndMs: number | null = null;
	let activeMs = 0;
	const seenMessages = new Set<string>();
	const addTurn = (model: string | null | undefined, turn: TurnTokens): void => {
		totals.tokensIn += turn.input;
		totals.tokensOut += turn.output;
		totals.tokensCacheRead += turn.cacheRead;
		totals.tokensCacheWrite += turn.cacheWrite;
		const price = sources.prices.priceFor(model);
		if (price) {
			cost += turnCost(price, turn);
			costNoCache += turnCostNoCache(price, turn);
		} else if (turn.input || turn.output) {
			unpriced = true;
		}
	};

	for (const session of sessions) {
		count(statuses, session.meta.status || "unknown");
		const ended = Date.parse(session.meta.ended_at ?? "");
		if (Number.isFinite(ended)) {
			if (lastEndMs === null || ended > lastEndMs) {
				lastEndMs = ended;
			}
			if (ended > session.startMs) {
				activeMs += Math.min(ended, endMs ?? ended) - session.startMs;
			}
		}
		const file = await readJson<{ messages?: ClineMessage[] } | ClineMessage[]>(
			join(sources.clineSessionsPath, session.dir, `${session.dir}.messages.json`),
		);
		const messages = Array.isArray(file) ? file : (file?.messages ?? []);
		let sessionInput = 0;
		for (const message of messages) {
			if (message.id) {
				if (seenMessages.has(message.id)) {
					continue;
				}
				seenMessages.add(message.id);
			}
			const inputTokens = message.metrics?.inputTokens || 0;
			// The empty trailing assistant message carries the session's cumulative totals.
			if (
				message.role === "assistant" &&
				isEmptyContent(message.content) &&
				sessionInput > 0 &&
				inputTokens >= sessionInput * CUMULATIVE_TOTALS_RATIO
			) {
				continue;
			}
			if (message.role === "assistant") {
				sessionInput += inputTokens;
				totals.assistantTurns += 1;
				const key = message.modelInfo
					? `${message.modelInfo.provider}/${message.modelInfo.id}`
					: session.meta.model
						? `${session.meta.provider}/${session.meta.model}`
						: null;
				if (key) {
					count(models, key);
					if (inRound(session.startMs)) {
						count(roundModels, key);
					}
				}
				addTurn(message.modelInfo?.id || session.meta.model, {
					input: inputTokens,
					output: message.metrics?.outputTokens || 0,
					cacheRead: message.metrics?.cacheReadTokens || 0,
					cacheWrite: message.metrics?.cacheWriteTokens || 0,
				});
			}
			for (const block of Array.isArray(message.content) ? message.content : []) {
				const typed = block as { type?: string; is_error?: boolean; content?: unknown };
				if (typed.type === "tool_use") {
					totals.toolCalls += 1;
				}
				if (typed.type === "tool_result") {
					const inner = Array.isArray(typed.content) ? (typed.content as Array<{ success?: boolean } | null>) : [];
					if (typed.is_error || inner.some((item) => item && item.success === false)) {
						totals.toolErrors += 1;
					}
				}
			}
		}
	}

	// A Codex card (no Cline sessions): measure its Codex rollouts instead.
	const codex = sessions.length
		? []
		: await loadCodexSessions(sources.codexSessionsPath, id, sources.worktreeRoots, endMs);
	for (const session of codex) {
		const key = `codex/${session.model || "unknown"}`;
		totals.toolCalls += session.toolCalls;
		totals.toolErrors += session.toolErrors;
		for (const turn of session.turns) {
			totals.assistantTurns += 1;
			count(models, key);
			if (inRound(session.startMs)) {
				count(roundModels, key);
			}
			addTurn(session.model, turn);
		}
		if (lastEndMs === null || session.endMs > lastEndMs) {
			lastEndMs = session.endMs;
		}
		activeMs += session.endMs - session.startMs;
	}
	const measured: Array<{ startMs: number }> = sessions.length ? sessions : codex;

	// The dominant model by assistant turns in THIS round's sessions (started after the previous review snapshot, i.e.
	// the rework), else over all sessions; else the newest session's settings; else the board.
	let provider: string | null = null;
	let model: string | null = null;
	let modelSource: CardMetrics["modelSource"] = "session";
	const attribution: CardMetrics["attribution"] =
		previousSnapshot && Object.keys(roundModels).length ? "round" : "all";
	const top = Object.entries(attribution === "round" ? roundModels : models).sort((a, b) => b[1] - a[1])[0]?.[0];
	const lastSession = sessions.at(-1);
	if (top) {
		const slash = top.indexOf("/");
		provider = top.slice(0, slash);
		model = top.slice(slash + 1);
	} else if (lastSession?.meta.model) {
		provider = lastSession.meta.provider ?? null;
		model = lastSession.meta.model;
	} else {
		modelSource = "board";
		provider = card?.providerId ?? null;
		model = card?.modelId ?? null;
	}

	const agent: RuntimeAgentId | null = sessions.length
		? "cline"
		: codex.length
			? "codex"
			: (card?.agentId ?? input.selectedAgentId ?? null);
	const startMs = measured[0]?.startMs ?? null;
	const wallEndMs = endMs ?? lastEndMs;
	const priced = measured.length > 0 && !unpriced;
	return {
		devId: id,
		title: card?.title ?? sessions[0]?.meta.metadata?.title ?? null,
		agent,
		column: card?.column ?? null,
		provider,
		model,
		modelSource,
		attribution,
		roundSince: previousSnapshot ? new Date(previousSnapshot.ms).toISOString() : null,
		models,
		roundModels,
		boardModel: card?.modelId ? `${card.providerId ? `${card.providerId}/` : ""}${card.modelId}` : null,
		metrics: {
			wallMin: startMs !== null && wallEndMs !== null ? roundTenth((wallEndMs - startMs) / 60000) : null,
			activeMin: measured.length ? roundTenth(activeMs / 60000) : null,
			sessions: measured.length,
			...totals,
			costUSD: priced ? roundCents(cost) : null,
			costUSDNoCache: priced ? roundCents(costNoCache) : null,
		},
		wall: {
			start: startMs !== null ? new Date(startMs).toISOString() : null,
			end: wallEndMs !== null ? new Date(wallEndMs).toISOString() : null,
			endSource: snapshot
				? `snapshot ${snapshot.sha.slice(0, 8)}`
				: wallEndMs !== null
					? endMs !== null
						? "--at"
						: "last session end"
					: null,
		},
		sessionStatuses: statuses,
	};
}
