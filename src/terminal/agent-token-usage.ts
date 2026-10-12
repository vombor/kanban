// Token counts of a card's agent runs, read from each agent CLI's own session files, for the board card's token count
// (user request 2026-10-12). Counts only, no prices: the team kit's card metrics (src/kits/team/bench/card-metrics.ts)
// price Cline and Codex turns for the scoreboard. A session belongs to a worktree when its cwd is the worktree or
// inside it, whichever agent wrote it, so a card that changed agents counts every run.
//
//  - Claude Code: `~/.claude/projects/<worktree path, every non-alphanumeric as ->/*.jsonl`, `message.usage` on
//    assistant lines. One API message is written once per content block under the same id, so the last line per id
//    counts, and ids are counted once across files.
//  - Cline (3.x): `<data>/sessions/<id>/<id>.messages.json`, `metrics` on assistant messages (inputTokens include the
//    cache reads and writes, on Lemonade and Bedrock alike), de-duplicated by message id across sessions (a resumed
//    session copies the earlier messages); the empty trailing assistant message that carries the session's
//    cumulative totals is skipped, as card-metrics does.
//  - Codex: `<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl` whose session_meta cwd is the worktree; each change of
//    `total_token_usage` adds that turn's `last_token_usage` (its input_tokens include cached_input_tokens).
//  - Copilot: `<copilot home>/session-state/<id>/events.jsonl` (the worktree from workspace.yaml's cwd). Only
//    `session.shutdown` carries token totals (cumulative for the session), so a Copilot session counts once it ends.
//
// The JSONL files only grow, so they are read on from the last complete line; Cline's messages.json is rewritten whole
// and parsed again only when its size or mtime changes. A session's cwd never changes and is cached per file.
import type { Dirent } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface TokenCounts {
	/** Input tokens not read from or written to the prompt cache. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface AgentTokenUsageSources {
	claudeProjectsPath: string;
	clineSessionsPath: string;
	codexSessionsPath: string;
	copilotSessionStatePath: string;
}

export interface AgentTokenUsageReader {
	/** Token counts per worktree path (keyed as given) over every agent session run in it; worktrees with none are left out. */
	read(worktreePaths: readonly string[], sources: AgentTokenUsageSources): Promise<Map<string, TokenCounts>>;
}

const CLINE_SESSION_DIR = /^\d+_[a-z0-9]+$/iu;
const CODEX_ROLLOUT_FILE = /^rollout-.*\.jsonl$/u;
const CODEX_WALK_DEPTH = 3;
const HEAD_BYTES = 8192;
const CUMULATIVE_TOTALS_RATIO = 0.99;
/** A cache entry not used for this long is dropped (a project nobody looks at, a card long gone). */
const CACHE_IDLE_MS = 60 * 60 * 1000;

export function emptyTokenCounts(): TokenCounts {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addTokenCounts(target: TokenCounts, counts: TokenCounts): void {
	target.input += counts.input;
	target.output += counts.output;
	target.cacheRead += counts.cacheRead;
	target.cacheWrite += counts.cacheWrite;
}

export function getTokenCountsTotal(counts: TokenCounts): number {
	return counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
}

/** Claude Code's transcript dir for a project path (src/terminal/orchestrator-agents.ts reads the same dir). */
export function getClaudeProjectTranscriptDir(claudeProjectsPath: string, projectPath: string): string {
	return join(claudeProjectsPath, projectPath.replace(/[^A-Za-z0-9]/gu, "-"));
}

function normalizePath(path: string): string {
	return resolve(path).replace(/[\\/]+$/u, "");
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

interface CachedEntry {
	usedAt: number;
}

interface JsonlTail<S> extends CachedEntry {
	size: number;
	mtimeMs: number;
	/** Bytes read up to the end of the last complete line. */
	offset: number;
	state: S;
}

interface WholeFile<S> extends CachedEntry {
	size: number;
	mtimeMs: number;
	state: S;
}

interface CachedValue<T> extends CachedEntry {
	value: T;
}

function pruneIdle(cache: Map<string, CachedEntry>, now: number): void {
	for (const [key, entry] of cache) {
		if (now - entry.usedAt > CACHE_IDLE_MS) {
			cache.delete(key);
		}
	}
}

/** Reads the lines appended to a JSONL file since the last call into its state; null when the file can't be read. */
async function readJsonlIncrementally<S>(
	cache: Map<string, JsonlTail<S>>,
	path: string,
	init: () => S,
	apply: (state: S, record: Record<string, unknown>) => void,
	now: number,
): Promise<S | null> {
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) {
		cache.delete(path);
		return null;
	}
	let entry = cache.get(path);
	if (entry && info.size === entry.size && info.mtimeMs === entry.mtimeMs) {
		entry.usedAt = now;
		return entry.state;
	}
	if (!entry || info.size < entry.offset) {
		entry = { size: 0, mtimeMs: 0, offset: 0, state: init(), usedAt: now };
	}
	const handle = await open(path, "r").catch(() => null);
	if (!handle) {
		return entry.state;
	}
	try {
		const length = info.size - entry.offset;
		const buffer = Buffer.alloc(Math.max(0, length));
		const { bytesRead } = length > 0 ? await handle.read(buffer, 0, length, entry.offset) : { bytesRead: 0 };
		const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
		if (end >= 0) {
			for (const line of buffer.toString("utf8", 0, end).split("\n")) {
				if (!line.trim()) {
					continue;
				}
				try {
					const record = asRecord(JSON.parse(line));
					if (record) {
						apply(entry.state, record);
					}
				} catch {
					// A torn or foreign line: skip it.
				}
			}
			entry.offset += end + 1;
		}
	} finally {
		await handle.close();
	}
	entry.size = info.size;
	entry.mtimeMs = info.mtimeMs;
	entry.usedAt = now;
	cache.set(path, entry);
	return entry.state;
}

async function readWholeFile<S>(
	cache: Map<string, WholeFile<S>>,
	path: string,
	parse: (text: string) => S,
	now: number,
): Promise<S | null> {
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) {
		cache.delete(path);
		return null;
	}
	const cached = cache.get(path);
	if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
		cached.usedAt = now;
		return cached.state;
	}
	const text = await readFile(path, "utf8").catch(() => null);
	if (text === null) {
		return cached?.state ?? null;
	}
	const state = parse(text);
	cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, state, usedAt: now });
	return state;
}

/** A value read once per key (a session's cwd never changes); a failed read (null) is tried again next time. */
async function readOnce<T>(
	cache: Map<string, CachedValue<T | null>>,
	key: string,
	load: () => Promise<T | null>,
	now: number,
): Promise<T | null> {
	const cached = cache.get(key);
	if (cached) {
		cached.usedAt = now;
		return cached.value;
	}
	const value = await load();
	if (value !== null) {
		cache.set(key, { value, usedAt: now });
	}
	return value;
}

async function readHead(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function listNames(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

/** Claude Code's lines: the last usage per message id. */
interface ClaudeTranscriptState {
	byMessageId: Map<string, TokenCounts>;
	withoutId: TokenCounts;
}

function applyClaudeLine(state: ClaudeTranscriptState, record: Record<string, unknown>): void {
	if (record.type !== "assistant") {
		return;
	}
	const message = asRecord(record.message);
	const usage = asRecord(message?.usage);
	if (!usage) {
		return;
	}
	const counts: TokenCounts = {
		input: count(usage.input_tokens),
		output: count(usage.output_tokens),
		cacheRead: count(usage.cache_read_input_tokens),
		cacheWrite: count(usage.cache_creation_input_tokens),
	};
	const id = typeof message?.id === "string" ? message.id : null;
	if (id) {
		state.byMessageId.set(id, counts);
	} else {
		addTokenCounts(state.withoutId, counts);
	}
}

/** Cline's assistant turns, after dropping the cumulative-totals message. */
interface ClineTurn {
	id: string | null;
	counts: TokenCounts;
}

function parseClineMessages(text: string): ClineTurn[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const messages = Array.isArray(parsed) ? parsed : asRecord(parsed)?.messages;
	if (!Array.isArray(messages)) {
		return [];
	}
	const turns: ClineTurn[] = [];
	let sessionInput = 0;
	for (const value of messages) {
		const message = asRecord(value);
		if (message?.role !== "assistant") {
			continue;
		}
		const metrics = asRecord(message.metrics);
		const input = count(metrics?.inputTokens);
		const isEmpty = !Array.isArray(message.content) || message.content.length === 0;
		if (isEmpty && sessionInput > 0 && input >= sessionInput * CUMULATIVE_TOTALS_RATIO) {
			continue;
		}
		sessionInput += input;
		const cacheRead = count(metrics?.cacheReadTokens);
		const cacheWrite = count(metrics?.cacheWriteTokens);
		turns.push({
			id: typeof message.id === "string" ? message.id : null,
			counts: {
				input: Math.max(0, input - cacheRead - cacheWrite),
				output: count(metrics?.outputTokens),
				cacheRead,
				cacheWrite,
			},
		});
	}
	return turns;
}

interface CodexRolloutState {
	lastTotal: unknown;
	counts: TokenCounts;
}

function applyCodexLine(state: CodexRolloutState, record: Record<string, unknown>): void {
	const payload = asRecord(record.payload);
	if (payload?.type !== "token_count") {
		return;
	}
	const info = asRecord(payload.info);
	const total = asRecord(info?.total_token_usage)?.total_tokens;
	if (total === undefined || total === state.lastTotal) {
		return;
	}
	state.lastTotal = total;
	const usage = asRecord(info?.last_token_usage) ?? {};
	const cacheRead = count(usage.cached_input_tokens);
	const cacheWrite = count(usage.cache_write_input_tokens);
	addTokenCounts(state.counts, {
		input: Math.max(0, count(usage.input_tokens) - cacheRead - cacheWrite),
		output: count(usage.output_tokens),
		cacheRead,
		cacheWrite,
	});
}

interface CopilotEventsState {
	counts: TokenCounts | null;
}

function applyCopilotLine(state: CopilotEventsState, record: Record<string, unknown>): void {
	if (record.type !== "session.shutdown") {
		return;
	}
	const details = asRecord(asRecord(record.data)?.tokenDetails);
	if (!details) {
		return;
	}
	const tokens = (key: string) => count(asRecord(details[key])?.tokenCount);
	state.counts = {
		input: tokens("input"),
		output: tokens("output"),
		cacheRead: tokens("cache_read"),
		cacheWrite: tokens("cache_write"),
	};
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

export function createAgentTokenUsageReader(options: { now?: () => number } = {}): AgentTokenUsageReader {
	const now = options.now ?? Date.now;
	const claudeFiles = new Map<string, JsonlTail<ClaudeTranscriptState>>();
	const clineFiles = new Map<string, WholeFile<ClineTurn[]>>();
	const codexFiles = new Map<string, JsonlTail<CodexRolloutState>>();
	const copilotFiles = new Map<string, JsonlTail<CopilotEventsState>>();
	const sessionCwds = new Map<string, CachedValue<string[] | null>>();

	return {
		read: async (worktreePaths, sources) => {
			const at = now();
			const worktrees = new Map<string, { key: string; counts: TokenCounts; seen: Set<string> }>();
			for (const path of worktreePaths) {
				worktrees.set(normalizePath(path), { key: path, counts: emptyTokenCounts(), seen: new Set() });
			}
			const findWorktree = (cwds: readonly string[]) => {
				for (const cwd of cwds) {
					const normalized = normalizePath(cwd);
					for (const [path, worktree] of worktrees) {
						if (normalized === path || normalized.startsWith(`${path}${sep}`)) {
							return worktree;
						}
					}
				}
				return null;
			};
			const addOnce = (
				worktree: { counts: TokenCounts; seen: Set<string> },
				id: string | null,
				counts: TokenCounts,
			) => {
				if (id) {
					if (worktree.seen.has(id)) {
						return;
					}
					worktree.seen.add(id);
				}
				addTokenCounts(worktree.counts, counts);
			};

			for (const [path, worktree] of worktrees) {
				const dir = getClaudeProjectTranscriptDir(sources.claudeProjectsPath, path);
				for (const name of await listNames(dir)) {
					if (!name.endsWith(".jsonl")) {
						continue;
					}
					const state = await readJsonlIncrementally(
						claudeFiles,
						join(dir, name),
						() => ({ byMessageId: new Map(), withoutId: emptyTokenCounts() }),
						applyClaudeLine,
						at,
					);
					if (!state) {
						continue;
					}
					for (const [id, counts] of state.byMessageId) {
						addOnce(worktree, `claude:${id}`, counts);
					}
					addTokenCounts(worktree.counts, state.withoutId);
				}
			}

			for (const name of await listNames(sources.clineSessionsPath)) {
				if (!CLINE_SESSION_DIR.test(name)) {
					continue;
				}
				const dir = join(sources.clineSessionsPath, name);
				const cwds = await readOnce(
					sessionCwds,
					`cline:${dir}`,
					async () => {
						const meta = asRecord(
							JSON.parse(await readFile(join(dir, `${name}.json`), "utf8").catch(() => "null")),
						);
						const paths = [meta?.cwd, meta?.workspace_root].filter(
							(value): value is string => typeof value === "string" && value.length > 0,
						);
						return paths.length > 0 ? paths : null;
					},
					at,
				);
				const worktree = cwds ? findWorktree(cwds) : null;
				if (!worktree) {
					continue;
				}
				const turns = await readWholeFile(clineFiles, join(dir, `${name}.messages.json`), parseClineMessages, at);
				for (const turn of turns ?? []) {
					addOnce(worktree, turn.id ? `cline:${turn.id}` : null, turn.counts);
				}
			}

			for (const file of await listCodexRollouts(sources.codexSessionsPath)) {
				const cwds = await readOnce(
					sessionCwds,
					`codex:${file}`,
					async () => {
						const cwd = /"cwd":"([^"]*)"/u.exec(await readHead(file).catch(() => ""))?.[1];
						return cwd ? [cwd] : null;
					},
					at,
				);
				const worktree = cwds ? findWorktree(cwds) : null;
				if (!worktree) {
					continue;
				}
				const state = await readJsonlIncrementally(
					codexFiles,
					file,
					() => ({ lastTotal: null, counts: emptyTokenCounts() }),
					applyCodexLine,
					at,
				);
				if (state) {
					addTokenCounts(worktree.counts, state.counts);
				}
			}

			for (const name of await listNames(sources.copilotSessionStatePath)) {
				const dir = join(sources.copilotSessionStatePath, name);
				const cwds = await readOnce(
					sessionCwds,
					`copilot:${dir}`,
					async () => {
						const text = await readFile(join(dir, "workspace.yaml"), "utf8").catch(() => "");
						const cwd = /^cwd:\s*(.+)$/mu.exec(text)?.[1]?.trim();
						return cwd ? [cwd] : null;
					},
					at,
				);
				const worktree = cwds ? findWorktree(cwds) : null;
				if (!worktree) {
					continue;
				}
				const state = await readJsonlIncrementally(
					copilotFiles,
					join(dir, "events.jsonl"),
					() => ({ counts: null }),
					applyCopilotLine,
					at,
				);
				if (state?.counts) {
					addTokenCounts(worktree.counts, state.counts);
				}
			}

			for (const cache of [claudeFiles, clineFiles, codexFiles, copilotFiles, sessionCwds]) {
				pruneIdle(cache, at);
			}
			const usage = new Map<string, TokenCounts>();
			for (const worktree of worktrees.values()) {
				if (getTokenCountsTotal(worktree.counts) > 0) {
					usage.set(worktree.key, worktree.counts);
				}
			}
			return usage;
		},
	};
}
