import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type CardMetricsCard,
	type CardMetricsSources,
	computeCardMetrics,
	isTaskWorktreePath,
	type ReviewSnapshot,
} from "../../../../../src/kits/team/bench/card-metrics";
import { createPriceTable, turnCost } from "../../../../../src/kits/team/bench/prices";
import { createTempDir } from "../../../../utilities/temp-dir";

const TASK = "abc12";
const prices = createPriceTable(
	{
		prices: [
			// $1 / $10 per 1M; cache reads $0.1, writes $2.
			{ pattern: "kimi-k3", in: 1, cacheRead: 0.1, cacheWrite: 2, out: 10 },
			{
				pattern: "gpt-6-luna",
				in: 1,
				cacheRead: 1,
				cacheWrite: 1,
				out: 1,
				longOver: 100,
				long: { in: 2, cacheRead: 2, cacheWrite: 2, out: 2 },
			},
			{ pattern: "gpt-6", in: 3, cacheRead: 3, cacheWrite: 3, out: 3 },
		],
	},
	"test",
);

let root: { path: string; cleanup: () => void };
let worktreesRoot: string;
let clineSessions: string;
let codexSessions: string;

function sources(snapshots: ReviewSnapshot[] = []): CardMetricsSources {
	return {
		clineSessionsPath: clineSessions,
		codexSessionsPath: codexSessions,
		worktreeRoots: [worktreesRoot],
		prices,
		readSnapshots: async (_taskId, atMs) =>
			snapshots.filter((snapshot) => atMs === null || snapshot.ms <= atMs).sort((a, b) => b.ms - a.ms),
	};
}

function writeClineSession(
	name: string,
	meta: Record<string, unknown>,
	messages: Array<Record<string, unknown>>,
): void {
	const dir = join(clineSessions, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.json`), JSON.stringify(meta));
	writeFileSync(join(dir, `${name}.messages.json`), JSON.stringify({ messages }));
}

const assistant = (id: string, model: string, input: number, output: number, extra: Record<string, unknown> = {}) => ({
	id,
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	modelInfo: { provider: "bedrock", id: model },
	metrics: { inputTokens: input, outputTokens: output, ...extra },
});

const card: CardMetricsCard = {
	id: TASK,
	title: "Fix the thing",
	agentId: null,
	providerId: "bedrock",
	modelId: "us.board.model",
	column: "review",
};

beforeEach(() => {
	root = createTempDir("card-metrics-");
	worktreesRoot = join(root.path, "worktrees");
	clineSessions = join(root.path, "cline", "sessions");
	codexSessions = join(root.path, "codex", "sessions");
	mkdirSync(clineSessions, { recursive: true });
});

afterEach(() => {
	root.cleanup();
});

describe("card metrics", () => {
	it("de-duplicates a resumed session's copied messages and skips the cumulative trailing message", async () => {
		const cwd = join(worktreesRoot, TASK, "repo");
		writeClineSession(
			"1000_aaaa",
			{ status: "completed", started_at: "2026-10-05T10:00:00Z", ended_at: "2026-10-05T10:10:00Z", cwd },
			[
				{ id: "u1", role: "user", content: [{ type: "text", text: "go" }] },
				assistant("m1", "us.moonshotai.kimi-k3", 1000, 100, { cacheReadTokens: 400, cacheWriteTokens: 100 }),
				{
					id: "u2",
					role: "user",
					content: [{ type: "tool_result", is_error: true, content: [] }],
				},
				assistant("m2", "us.moonshotai.kimi-k3", 2000, 200),
				// The session's cumulative totals: empty content, input ≥ the session's input so far.
				{ id: "m-total", role: "assistant", content: [], metrics: { inputTokens: 3000, outputTokens: 300 } },
			],
		);
		// The resumed session copies m1/m2 and adds m3.
		writeClineSession(
			"2000_bbbb",
			{
				status: "completed",
				started_at: "2026-10-05T11:00:00Z",
				ended_at: "2026-10-05T11:05:00Z",
				workspace_root: cwd,
			},
			[
				assistant("m1", "us.moonshotai.kimi-k3", 1000, 100, { cacheReadTokens: 400, cacheWriteTokens: 100 }),
				assistant("m2", "us.moonshotai.kimi-k3", 2000, 200),
				{ ...assistant("m3", "us.moonshotai.kimi-k3", 500, 50), content: [{ type: "tool_use", name: "x" }] },
			],
		);
		// Another card's session is not counted.
		writeClineSession(
			"3000_cccc",
			{ cwd: join(worktreesRoot, "other", "repo"), started_at: "2026-10-05T10:00:00Z" },
			[assistant("z1", "us.moonshotai.kimi-k3", 99999, 99999)],
		);

		const metrics = await computeCardMetrics({ taskId: TASK, card }, sources());
		expect(metrics.metrics.assistantTurns).toBe(3);
		expect(metrics.metrics.tokensIn).toBe(3500);
		expect(metrics.metrics.tokensOut).toBe(350);
		expect(metrics.metrics.toolCalls).toBe(1);
		expect(metrics.metrics.toolErrors).toBe(1);
		expect(metrics.metrics.sessions).toBe(2);
		expect(metrics.metrics.activeMin).toBe(15);
		expect(metrics.metrics.wallMin).toBe(65);
		const kimi = prices.priceFor("kimi-k3");
		if (!kimi) {
			throw new Error("kimi price missing");
		}
		const expected =
			turnCost(kimi, { input: 1000, output: 100, cacheRead: 400, cacheWrite: 100 }) +
			turnCost(kimi, { input: 2000, output: 200, cacheRead: 0, cacheWrite: 0 }) +
			turnCost(kimi, { input: 500, output: 50, cacheRead: 0, cacheWrite: 0 });
		expect(metrics.metrics.costUSD).toBe(Math.round(expected * 100) / 100);
		expect(metrics).toMatchObject({
			agent: "cline",
			provider: "bedrock",
			model: "us.moonshotai.kimi-k3",
			modelSource: "session",
			attribution: "all",
			boardModel: "bedrock/us.board.model",
		});
		expect(metrics.wall.endSource).toBe("last session end");
	});

	it("attributes a rework round to the model of the sessions after the previous review snapshot, up to the latest", async () => {
		const cwd = join(worktreesRoot, TASK, "repo");
		writeClineSession("1000_aaaa", { started_at: "2026-10-05T10:00:00Z", ended_at: "2026-10-05T10:30:00Z", cwd }, [
			assistant("a1", "us.openai.gpt-6.1-sol", 10, 10),
			assistant("a2", "us.openai.gpt-6.1-sol", 10, 10),
		]);
		writeClineSession("2000_bbbb", { started_at: "2026-10-05T12:00:00Z", ended_at: "2026-10-05T12:20:00Z", cwd }, [
			assistant("b1", "us.moonshotai.kimi-k3", 10, 10),
		]);
		// Started after the latest snapshot: not part of this round.
		writeClineSession("3000_cccc", { started_at: "2026-10-05T15:00:00Z", cwd }, [
			assistant("c1", "us.openai.gpt-6.1-sol", 10, 10),
		]);
		const snapshots = [
			{ sha: "1111111111", ms: Date.parse("2026-10-05T11:00:00Z") },
			{ sha: "2222222222", ms: Date.parse("2026-10-05T13:00:00Z") },
		];
		const metrics = await computeCardMetrics({ taskId: TASK, card }, sources(snapshots));
		expect(metrics.attribution).toBe("round");
		expect(metrics.model).toBe("us.moonshotai.kimi-k3");
		expect(metrics.models).toEqual({ "bedrock/us.openai.gpt-6.1-sol": 2, "bedrock/us.moonshotai.kimi-k3": 1 });
		expect(metrics.roundSince).toBe("2026-10-05T11:00:00.000Z");
		expect(metrics.wall.endSource).toBe("snapshot 22222222");
		expect(metrics.metrics.wallMin).toBe(180);

		// --at picks the first snapshot: only the first session counts.
		const backfill = await computeCardMetrics({ taskId: TASK, card, at: "2026-10-05T11:30:00Z" }, sources(snapshots));
		expect(backfill.model).toBe("us.openai.gpt-6.1-sol");
		expect(backfill.attribution).toBe("all");
		expect(backfill.metrics.assistantTurns).toBe(2);
	});

	it("prices long-context turns at the long rate and gives no cost when a turn's model has no price", async () => {
		const cwd = join(worktreesRoot, TASK, "repo");
		writeClineSession("1000_aaaa", { started_at: "2026-10-05T10:00:00Z", cwd }, [
			assistant("a1", "us.openai.gpt-6-luna", 200, 0),
		]);
		const priced = await computeCardMetrics({ taskId: TASK, card }, sources());
		expect(priced.metrics.costUSD).toBe(0); // 200 * $2 / 1M rounds to 0.00
		expect(priced.metrics.costUSDNoCache).toBe(0);

		writeClineSession("2000_bbbb", { started_at: "2026-10-05T11:00:00Z", cwd }, [
			assistant("b1", "local.unknown", 10, 10),
		]);
		const unpriced = await computeCardMetrics({ taskId: TASK, card }, sources());
		expect(unpriced.metrics.costUSD).toBeNull();
	});

	it("measures a Codex card from its rollouts (token_count changes only)", async () => {
		const dir = join(codexSessions, "2026", "10", "05");
		mkdirSync(dir, { recursive: true });
		const cwd = join(worktreesRoot, TASK, "repo");
		const lines = [
			{ timestamp: "2026-10-05T10:00:00Z", type: "session_meta", payload: { cwd } },
			{ timestamp: "2026-10-05T10:00:01Z", type: "turn_context", payload: { model: "gpt-6-terra" } },
			{ timestamp: "2026-10-05T10:01:00Z", type: "response_item", payload: { type: "function_call" } },
			{
				timestamp: "2026-10-05T10:01:10Z",
				type: "response_item",
				payload: { type: "function_call_output", output: "Process exited with code 1" },
			},
			{
				timestamp: "2026-10-05T10:02:00Z",
				type: "event_msg",
				payload: {
					type: "token_count",
					info: {
						total_token_usage: { total_tokens: 150 },
						last_token_usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 40 },
					},
				},
			},
			// Same total: not a new turn.
			{
				timestamp: "2026-10-05T10:02:30Z",
				type: "event_msg",
				payload: {
					type: "token_count",
					info: {
						total_token_usage: { total_tokens: 150 },
						last_token_usage: { input_tokens: 100, output_tokens: 50 },
					},
				},
			},
			{ timestamp: "2026-10-05T10:10:00Z", type: "event_msg", payload: { type: "agent_message" } },
		];
		writeFileSync(join(dir, "rollout-2026-10-05-x.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"));
		writeFileSync(
			join(dir, "rollout-2026-10-05-other.jsonl"),
			JSON.stringify({ timestamp: "2026-10-05T10:00:00Z", type: "session_meta", payload: { cwd: "/elsewhere" } }),
		);
		const metrics = await computeCardMetrics({ taskId: TASK, card: { ...card, agentId: "codex" } }, sources());
		expect(metrics).toMatchObject({
			agent: "codex",
			provider: "codex",
			model: "gpt-6-terra",
			modelSource: "session",
		});
		expect(metrics.metrics).toMatchObject({
			assistantTurns: 1,
			tokensIn: 100,
			tokensOut: 50,
			tokensCacheRead: 40,
			toolCalls: 1,
			toolErrors: 1,
			sessions: 1,
			activeMin: 10,
		});
		expect(metrics.metrics.costUSD).toBe(0);
	});

	it("falls back to the board's model and the effective agent when the card left no session files", async () => {
		const fromCard = await computeCardMetrics({ taskId: TASK, card: { ...card, agentId: "claude" } }, sources());
		expect(fromCard).toMatchObject({
			agent: "claude",
			model: "us.board.model",
			provider: "bedrock",
			modelSource: "board",
		});
		expect(fromCard.metrics.costUSD).toBeNull();
		// No agent on the card: the agent selected in Kanban settings (plan §4.0), never "unknown".
		const selected = await computeCardMetrics({ taskId: TASK, card, selectedAgentId: "claude" }, sources());
		expect(selected.agent).toBe("claude");
	});

	it("matches a session to a task by the worktree root or any worktrees dir, never by a name prefix", () => {
		expect(isTaskWorktreePath(join(worktreesRoot, TASK, "repo"), TASK, [worktreesRoot])).toBe(true);
		expect(isTaskWorktreePath(join(worktreesRoot, `${TASK}x`, "repo"), TASK, [worktreesRoot])).toBe(false);
		expect(isTaskWorktreePath(`/old/home/worktrees/${TASK}/repo`, TASK, [worktreesRoot])).toBe(true);
		expect(isTaskWorktreePath(`/custom-root/${TASK}/repo`, TASK, ["/custom-root"])).toBe(true);
		expect(isTaskWorktreePath("", TASK, [worktreesRoot])).toBe(false);
	});
});
