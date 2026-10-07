// The cutover's shadow diff (plan §8.4 step 1, §9: "shadow mode + scripts/pipeline-shadow-diff.ts during cutover"):
// the legacy autoland log parser on lines in the exact shapes autoland writes, and the comparison against a stub
// routing policy (no test here reads kits/team.json).
import { describe, expect, it } from "vitest";

import type { OnFailAnswer, QaPolicyAnswer, RoutingPolicy } from "../../../src/kits/policy";
import type { PipelineDecisionRecord } from "../../../src/pipeline/decision-log";
import { parseLegacyAutolandLog } from "../../../src/pipeline/shadow-diff/legacy-autoland-log";
import { parseJsonLines } from "../../../src/pipeline/shadow-diff/load-shadow-diff-inputs";
import {
	computeShadowDiff,
	type ShadowDiffInput,
	type ShadowDiffItem,
} from "../../../src/pipeline/shadow-diff/shadow-diff";
import { formatShadowDiffReport } from "../../../src/pipeline/shadow-diff/shadow-diff-report";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const WS = "foo";
const T0 = Date.parse("2026-10-07T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function line(minutes: number, text: string): string {
	return `${at(minutes)} ${text}`;
}

function decision(minutes: number, overrides: Partial<PipelineDecisionRecord>): PipelineDecisionRecord {
	return {
		at: at(minutes),
		workspaceId: WS,
		taskId: "d1111",
		stage: "qa_gate",
		kit: "stub",
		landingMode: "qa",
		shadow: true,
		effectiveAgent: { agentId: "cline", source: "card" },
		model: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" },
		role: "dev",
		answer: null,
		outcome: "shadow",
		note: "",
		...overrides,
	};
}

const QA_HAIKU: QaPolicyAnswer = {
	kind: "qa",
	agentId: "cline",
	model: { provider: "bedrock", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
	route: "qa.routes[0]",
	promptParts: {
		rules: [],
		blurb: "",
		notes: { screenshotFallback: "", knownBaseIssues: "", dbSetup: "" },
		serversScript: null,
	},
};

/** A stub kit: reworks below `reworkRounds` FAIL rounds (plus handback rounds), then escalates. */
function stubPolicy(reworkRounds = 3): RoutingPolicy & { onFailCalls: Array<{ failRounds: number; extra: number }> } {
	const onFailCalls: Array<{ failRounds: number; extra: number }> = [];
	return {
		onFailCalls,
		devAssignment: () => null,
		qaPolicy: () => QA_HAIKU,
		onFail: ({ history }): OnFailAnswer => {
			onFailCalls.push({ failRounds: history.failRounds.length, extra: history.extraRounds });
			return history.failRounds.length >= reworkRounds + history.extraRounds
				? { action: "escalate", to: "orchestrator", requireApproval: true, reason: "rounds used up" }
				: { action: "rework", clearContext: "auto" };
		},
		onPass: () => ({ action: "land" }),
	};
}

function createInput(overrides: Partial<ShadowDiffInput> & { log?: string[] }): ShadowDiffInput {
	const { log = [], ...rest } = overrides;
	return {
		workspaceId: WS,
		since: T0 - 60 * 60_000,
		until: T0 + 24 * 60 * 60_000,
		windowMs: 10 * 60_000,
		legacy: parseLegacyAutolandLog(log.join("\n")),
		decisions: [],
		devAssignments: [],
		board: createBoard({
			review: [
				createCard({
					id: "d1111",
					agentId: "cline",
					agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
				}),
			],
			backlog: [
				createCard({
					id: "b2222",
					title: "QA1 d1111: Wishlist",
					agentId: "cline",
					agentSettings: { providerId: "bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
				}),
			],
		}),
		selectedAgentId: "claude",
		kitName: "stub",
		policy: stubPolicy(),
		maxFailRounds: 3,
		legacyResets: {},
		...rest,
	};
}

function only(items: ShadowDiffItem[], category: ShadowDiffItem["category"]): ShadowDiffItem[] {
	return items.filter((item) => item.category === category);
}

describe("parseLegacyAutolandLog", () => {
	it("reads the decision lines autoland writes and skips the rest", () => {
		const log = parseLegacyAutolandLog(
			[
				line(0, "event foo/d1111: in_progress -> review"),
				line(0, "snapshot d1111: 81e2dc7f on dbc48fb4 (review)"),
				line(0, "snapshot d1111: unchanged (81e2dc7f)"),
				line(0, "qa d1111: created QA card b2222 (round 2) for snapshot 81e2dc7f"),
				line(0, "qa d1111: already created QA card b2222 for snapshot 81e2dc7f; not creating another"),
				line(0, "qa c3333: not a dev card (unpinned, Kanban default claude/QA card); not creating a QA card"),
				line(1, "qaflow d1111: acting on QA FAIL r2 (2026-10-07T10:00:30.000Z) for snapshot 81e2dc7f"),
				line(1, "qaflow d1111: handback 2026-10-07T10:01:00.000Z (+1 rounds): re-acting on FAIL r2"),
				line(
					1,
					"qaflow d1111: REWORK round 3 (2/2) sent to cline bedrock/us.openai.gpt-6.1-sol via chat (cleared); card -> in_progress",
				),
				line(2, "qaflow d1111: ESCALATED (3 FAIL rounds (rounds 1, 2, 3))"),
				line(2, "qaflow d1111: PASS r4, merges cleanly into master; moved to Done (landing next)"),
				line(2, "qaflow d1111: PASS r4 held for runoff coupons; lands only if it outscores e4444"),
				line(2, "qaflow d1111: PASS r4 but 81e2dc7f CONFLICTS with master (a.ts); not moving to Done"),
				line(3, "land d1111: fork/stack -> e2e3369 in /projects/kanban"),
				line(3, "land e4444: CONFLICT merging into master (a.ts); nothing landed."),
				line(
					4,
					"qaflow d1111: agent stopped with exit (corrupted history: cleared + full prompt); nudged bedrock/m (1/2); no QA.",
				),
				line(4, "qaflow d1111: agent stopped with error; nudged bedrock/m (1/2); no QA. 503"),
				line(
					4,
					'qaflow d1111: turn ended on an announcement without a tool call; sent "continue" to bedrock/m (1/8); no QA.',
				),
				line(4, "qaflow d1111: sent provider-error retry (1); moved to In Progress"),
				line(
					4,
					"qaflow d1111: provider error on bedrock/m (1/4); retrying in 1 min (2026-10-07T10:05:00.000Z); no QA",
				),
				line(
					5,
					"restart foo: Kanban started 2026-10-07T10:04:00.000Z (autoland last saw none): 2 orphaned card(s): d1111 (dev), c5555 (cal)",
				),
				line(5, "restart d1111: orphaned (dev, in_progress): session x (running) started before Kanban"),
				line(5, "restart d1111: resumed on bedrock/m (WIP tag preserve/d1111-wip-x-restart)"),
				"not a log line",
			].join("\n"),
		);
		expect(log.boardEvents).toEqual([{ at: at(0), workspaceId: "foo", taskId: "d1111" }]);
		expect(log.cards.map((event) => event.action)).toEqual([
			{ kind: "submitted", snapshot: "81e2dc7f" },
			{ kind: "qa_created", qaTaskId: "b2222", round: 2 },
			{ kind: "qa_existing" },
			{ kind: "qa_skipped", reason: "not a dev card (unpinned, Kanban default claude/QA card)" },
			{ kind: "verdict", verdict: "FAIL", round: 2 },
			{ kind: "handback", extraRounds: 1 },
			{ kind: "rework", round: 3, agent: "cline", model: "us.openai.gpt-6.1-sol", cleared: true },
			{ kind: "escalated", reason: "3 FAIL rounds (rounds 1, 2, 3)" },
			{ kind: "pass_land" },
			{ kind: "pass_held", runoff: "coupons" },
			{ kind: "conflict" },
			{ kind: "landed", base: "fork/stack", commit: "e2e3369" },
			{ kind: "conflict" },
			{ kind: "nudge", cause: "poisoned" },
			{ kind: "nudge", cause: "crash" },
			{ kind: "nudge", cause: "premature" },
			{ kind: "nudge", cause: "retry" },
			{ kind: "hold" },
			{ kind: "orphan" },
			{ kind: "resumed" },
		]);
		// Calibration orphans are left to the calibration runner by both sides.
		expect(log.restarts).toEqual([
			{
				at: at(5),
				workspaceId: "foo",
				serverStartedAt: "2026-10-07T10:04:00.000Z",
				lastSeenStartedAt: null,
				orphans: ["d1111"],
			},
		]);
	});

	it("reads the start autoland last saw", () => {
		const log = parseLegacyAutolandLog(
			line(
				5,
				"restart foo: Kanban started 2026-10-07T09:04:23.480Z (autoland last saw 2026-10-07T09:08:25.610Z): 0 orphaned card(s)",
			),
		);
		expect(log.restarts[0]?.lastSeenStartedAt).toBe("2026-10-07T09:08:25.610Z");
	});
});

describe("computeShadowDiff", () => {
	it("matches the kit's QA answer to the QA card autoland created, and flags a different QA model", () => {
		const log = [
			line(0, "event foo/d1111: in_progress -> review"),
			line(1, "qa d1111: created QA card b2222 (round 1) for snapshot aaaaaaaa"),
		];
		const same = computeShadowDiff(
			createInput({ log, decisions: [decision(0.5, { answer: QA_HAIKU }), decision(2, { answer: QA_HAIKU })] }),
		);
		expect(only(same.items, "qa_routing").map((item) => item.status)).toEqual(["same"]);
		expect(same.unexplained).toBe(0);

		const codex: QaPolicyAnswer = { ...QA_HAIKU, agentId: "codex", model: null, route: null };
		const different = computeShadowDiff(createInput({ log, decisions: [decision(1, { answer: codex })] }));
		expect(only(different.items, "qa_routing")).toMatchObject([
			{ status: "different", taskId: "d1111", pipeline: expect.stringContaining("codex") },
		]);
		expect(different.unexplained).toBe(1);
	});

	it("reports a QA decision only one side took, and the plan's known difference for Claude-built cards", () => {
		const report = computeShadowDiff(
			createInput({
				log: [
					line(0, "event foo/d1111: in_progress -> review"),
					line(0, "event foo/c3333: in_progress -> review"),
					line(0, "qa c3333: not a dev card (claude/QA card); not creating a QA card"),
					line(1, "qa d1111: created QA card b2222 (round 1) for snapshot aaaaaaaa"),
				],
				decisions: [
					decision(0, { taskId: "c3333", answer: QA_HAIKU }),
					// Hours later, with no legacy decision near it.
					decision(300, { answer: QA_HAIKU }),
				],
			}),
		);
		expect(only(report.items, "qa_routing").map((item) => [item.taskId, item.status])).toEqual([
			["c3333", "known"],
			["d1111", "legacy_only"],
			["d1111", "pipeline_only"],
		]);
		expect(report.unexplained).toBe(2);
	});

	it("asks the kit's onFail with the legacy FAIL history, handback rounds and restart-fresh resets", () => {
		const policy = stubPolicy(2);
		const report = computeShadowDiff(
			createInput({
				policy,
				log: [
					line(0, "event foo/d1111: in_progress -> review"),
					line(1, "qaflow d1111: acting on QA FAIL r1 (x) for snapshot a"),
					line(
						1,
						"qaflow d1111: REWORK round 2 (1/2) sent to cline bedrock/us.openai.gpt-6.1-sol via chat; card -> in_progress",
					),
					line(2, "qaflow d1111: acting on QA FAIL r2 (x) for snapshot b"),
					line(2, "qaflow d1111: ESCALATED (3 FAIL rounds (rounds 1, 2))"),
					// The handback is logged just after the verdict it re-acts on.
					line(3, "qaflow d1111: acting on QA FAIL r3 (x) for snapshot c"),
					line(3.001, "qaflow d1111: handback 2026-10-07T10:03:00.000Z (+2 rounds): re-acting on FAIL r3"),
					line(
						3.01,
						"qaflow d1111: REWORK round 4 (3/3) sent to cline bedrock/us.openai.gpt-6.1-sol via chat; card -> in_progress",
					),
					// A restart-fresh onto another model: only the FAIL its rework answers counts.
					line(4, "qaflow d1111: acting on QA FAIL r4 (x) for snapshot d"),
					line(
						4,
						"qaflow d1111: REWORK round 5 (1/2) sent to cline bedrock/qwen.qwen3-next-80b-a3b via chat; card -> in_progress",
					),
					line(5, "land d1111: CONFLICT merging into master (a.ts); nothing landed."),
				],
			}),
		);
		expect(policy.onFailCalls).toEqual([
			{ failRounds: 1, extra: 0 },
			{ failRounds: 2, extra: 0 },
			{ failRounds: 3, extra: 2 },
			{ failRounds: 1, extra: 2 },
			{ failRounds: 2, extra: 2 },
		]);
		expect(only(report.items, "on_fail").map((item) => item.status)).toEqual([
			"same",
			"same",
			"same",
			"same",
			// The conflict got neither a rework nor an escalation from autoland, but the kit says rework.
			"different",
		]);
	});

	it("counts FAILs only from the card's qaflow.resetAt", () => {
		const policy = stubPolicy(2);
		computeShadowDiff(
			createInput({
				policy,
				legacyResets: { d1111: at(1.5) },
				log: [
					line(1, "qaflow d1111: acting on QA FAIL r1 (x) for snapshot a"),
					line(2, "qaflow d1111: acting on QA FAIL r2 (x) for snapshot b"),
				],
			}),
		);
		expect(policy.onFailCalls.map((call) => call.failRounds)).toEqual([0, 1]);
	});

	it("evaluates a pruned card from its REWORK line, and leaves it unverified without one", () => {
		const report = computeShadowDiff(
			createInput({
				board: createBoard({}),
				log: [
					line(0, "event foo/d1111: in_progress -> review"),
					line(1, "qaflow d1111: acting on QA FAIL r1 (x) for snapshot a"),
					line(1, "qaflow d1111: REWORK round 2 (1/2) sent to cline bedrock/m via chat; card -> in_progress"),
					line(3, "qaflow d1111: acting on QA STALLED r2 (x) for snapshot b"),
					line(3, "qaflow d1111: ESCALATED (QA round 2 STALLED)"),
				],
			}),
		);
		expect(only(report.items, "on_fail").map((item) => item.status)).toEqual(["same", "unverified"]);
	});

	it("pairs recovery decisions with autoland's nudges and holds by card, kind and time", () => {
		const nudge = (cause: string) => ({ kind: "nudge", cause, clear: null });
		const report = computeShadowDiff(
			createInput({
				log: [
					line(0, "event foo/d1111: in_progress -> review"),
					line(1, "qaflow d1111: agent stopped with error; nudged bedrock/m (1/2); no QA. 503"),
					line(
						30,
						'qaflow d1111: turn ended on an announcement without a tool call; sent "continue" to bedrock/m (1/8); no QA.',
					),
					line(60, "qaflow d1111: provider error on bedrock/m (1/4); retrying in 1 min (x); no QA"),
				],
				decisions: [
					// Report mode repeats a decision on every evaluation until something changes.
					decision(0.5, { stage: "recovery", answer: nudge("crash"), outcome: "report" }),
					decision(1.5, { stage: "recovery", answer: nudge("crash"), outcome: "report" }),
					decision(30, { stage: "recovery", answer: nudge("poisoned"), outcome: "report" }),
					decision(120, { stage: "recovery", answer: { kind: "hold" }, outcome: "report" }),
					decision(125, { stage: "recovery", answer: { kind: "wait" }, outcome: "none" }),
				],
			}),
		);
		expect(only(report.items, "recovery").map((item) => item.status)).toEqual([
			"same",
			"different",
			"legacy_only",
			"pipeline_only",
		]);
	});

	it("compares restart orphans per Kanban start", () => {
		const start = "2026-10-07T10:04:00.000Z";
		const report = computeShadowDiff(
			createInput({
				log: [
					line(
						5,
						`restart foo: Kanban started ${start} (autoland last saw none): 1 orphaned card(s): d1111 (dev)`,
					),
					// Autoland logs a start twice when it flaps between two start records.
					line(6, `restart foo: Kanban started ${start} (autoland last saw x): 1 orphaned card(s): d1111 (dev)`),
					line(
						9,
						"restart foo: Kanban started 2026-10-07T10:08:00.000Z (autoland last saw x): 0 orphaned card(s)",
					),
				],
				decisions: [
					decision(5, {
						stage: "restart",
						taskId: null,
						answer: null,
						note: `Kanban started ${start}: 1 orphaned card(s)`,
					}),
					decision(5, { stage: "restart", answer: { kind: "resume" }, outcome: "report" }),
				],
			}),
		);
		expect(only(report.items, "restart").map((item) => item.status)).toEqual(["same", "legacy_only"]);
	});

	// 2026-10-07 09:08:25Z: autoland took a short-lived `node …/kanban … --port` process for a new server, then went
	// back to the real start 15 s later. Neither line is a restart.
	it("reports a start autoland went back from as a known phantom, not a restart", () => {
		const real = "2026-10-07T10:00:00.000Z";
		const phantom = "2026-10-07T10:04:00.000Z";
		const restart = (minutes: number, start: string, lastSeen: string, orphans = "0 orphaned card(s)") =>
			line(minutes, `restart foo: Kanban started ${start} (autoland last saw ${lastSeen}): ${orphans}`);
		const report = computeShadowDiff(
			createInput({
				log: [
					restart(0, real, "none"),
					restart(4, phantom, real),
					restart(4.25, real, phantom),
					restart(10, "2026-10-07T10:10:00.000Z", real, "1 orphaned card(s): d1111 (dev)"),
					restart(10.25, real, "2026-10-07T10:10:00.000Z"),
				],
				decisions: [
					decision(0.1, { stage: "worker", taskId: null, note: "watching: landing qa, recovery report" }),
				],
			}),
		);
		const restarts = only(report.items, "restart");
		expect(restarts.map((item) => [item.legacy.slice(0, 37), item.status])).toEqual([
			[`Kanban start ${real}`, "same"],
			[`Kanban start ${phantom}`, "known"],
			// A phantom autoland found orphans for may have resumed live cards: that stays a difference.
			["Kanban start 2026-10-07T10:10:00.000Z", "legacy_only"],
		]);
		expect(restarts[1]?.note).toContain(`it saw ${real} again`);
	});

	it("pairs the two sides' times for one Kanban start, and counts a start without orphans only while the pipeline watched", () => {
		const legacyStart = "2026-10-07T10:00:00.480Z";
		const restart = (minutes: number, start: string, orphans: string) =>
			line(minutes, `restart foo: Kanban started ${start} (autoland last saw none): ${orphans}`);
		// The server's own record is ~0.5 s after the /proc start autoland reads.
		const paired = computeShadowDiff(
			createInput({
				log: [restart(0.1, legacyStart, "1 orphaned card(s): d1111 (dev)")],
				decisions: [
					decision(0.1, {
						stage: "restart",
						taskId: null,
						answer: null,
						note: "Kanban started 2026-10-07T10:00:00.946Z: 1 orphaned card(s)",
					}),
					decision(0.1, { stage: "restart", answer: { kind: "resume" }, outcome: "report" }),
				],
			}),
		);
		expect(only(paired.items, "restart").map((item) => item.status)).toEqual(["same"]);

		const clean = (decisions: PipelineDecisionRecord[]) =>
			only(
				computeShadowDiff(createInput({ log: [restart(0.1, legacyStart, "0 orphaned card(s)")], decisions })).items,
				"restart",
			).map((item) => item.status);
		const worker = (note: string) => decision(0.2, { stage: "worker", taskId: null, note });
		expect(clean([worker("watching: landing qa, kit team, shadow, recovery report (report only)")])).toEqual([
			"same",
		]);
		expect(clean([worker("watching: landing qa, kit team, shadow, recovery off")])).toEqual(["legacy_only"]);
		expect(clean([])).toEqual(["legacy_only"]);
	});

	it("compares the kit's dev assignment proposal with what the card was created with", () => {
		const entry = (taskId: string, modelId: string) => ({
			at: at(1),
			workspaceId: WS,
			taskId,
			title: taskId,
			kit: "team",
			outcome: "shadow" as const,
			proposal: {
				agentId: "cline" as const,
				agentSettings: { providerId: "bedrock", modelId: "m-tier3" },
				tier: "tier3",
			},
			created: { agentId: "cline" as const, agentSettings: { providerId: "bedrock", modelId } },
		});
		const report = computeShadowDiff(
			createInput({ devAssignments: [entry("a1", "m-tier3"), entry("a2", "m-other")] }),
		);
		expect(only(report.items, "dev_assignment").map((item) => [item.taskId, item.status])).toEqual([
			["a1", "same"],
			["a2", "different"],
		]);
	});

	it("leaves out another workspace's cards and everything outside the window", () => {
		const report = computeShadowDiff(
			createInput({
				since: T0,
				log: [
					line(-5, "qa d1111: created QA card b2222 (round 1) for snapshot aaaaaaaa"),
					line(0, "event other/e4444: in_progress -> review"),
					line(1, "qa e4444: created QA card b2222 (round 1) for snapshot bbbbbbbb"),
				],
				decisions: [decision(1, { workspaceId: "other", taskId: "e4444", answer: QA_HAIKU })],
			}),
		);
		expect(report.items).toEqual([]);
		expect(formatShadowDiffReport(report)).toContain("No unexplained differences.");
	});
});

describe("parseJsonLines", () => {
	it("skips blank and torn lines", () => {
		expect(parseJsonLines<{ a: number }>('{"a":1}\n\n{"a":2}\n{"a":')).toEqual([{ a: 1 }, { a: 2 }]);
		expect(parseJsonLines(null)).toEqual([]);
	});
});
