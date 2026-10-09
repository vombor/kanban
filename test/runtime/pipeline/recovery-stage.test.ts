import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { getWorkspacePipelineSettings, parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeBoardCard, RuntimeBoardData } from "../../../src/core/api-contract";
import { createRoutingPolicy } from "../../../src/kits/policy";
import { getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";
import type { PipelineDecisionRecord } from "../../../src/pipeline/decision-log";
import type { PipelineSessionView, PipelineWorkspaceSnapshot } from "../../../src/pipeline/engine";
import type { PipelineWorkspaceState } from "../../../src/pipeline/pipeline-state";
import type { RecoveryFlowPatch } from "../../../src/pipeline/recovery";
import { RESTART_RESUME_NOTE, RESTART_WIP_NOTE } from "../../../src/pipeline/recovery-prompts";
import { applyRecoveryPatches } from "../../../src/pipeline/recovery-runtime";
import {
	createRecoveryStage,
	type RecoveryAction,
	type RecoveryActionResult,
	type RecoveryStageDependencies,
} from "../../../src/pipeline/recovery-stage";
import {
	markRestartManifestPlanned,
	type RestartManifest,
	readRestartManifest,
	removeRestartManifest,
	writeRestartManifest,
} from "../../../src/pipeline/restart-recovery";
import { createRestartManifestWriter } from "../../../src/server/restart-manifest-writer";
import { getRestartManifestPath } from "../../../src/state/kanban-home";
import type { ClineSessionDetail } from "../../../src/terminal/cline-session-files";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { PROVISIONAL_ALLOWED } from "../../utilities/routing-vetting";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const SERVER_START = NOW - 5 * 60_000;

function card(id: string, extra: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: `Prompt of ${id}.`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...extra,
	} as RuntimeBoardCard;
}

function board(columns: Partial<Record<string, RuntimeBoardCard[]>>): RuntimeBoardData {
	return {
		columns: ["backlog", "in_progress", "review", "trash"].map((id) => ({ id, title: id, cards: columns[id] ?? [] })),
		dependencies: [],
	} as unknown as RuntimeBoardData;
}

function session(taskId: string, extra: Partial<PipelineSessionView> = {}): PipelineSessionView {
	return {
		taskId,
		agentId: "cline",
		modelId: null,
		state: "awaiting_review",
		reviewReason: "hook",
		startedAt: NOW - 30 * 60_000,
		workspacePath: `/wt/${taskId}`,
		live: true,
		...extra,
	};
}

function finalReply(text: string, extra: Partial<ClineSessionDetail["snapshot"]> = {}): ClineSessionDetail {
	const content = [{ type: "text", text }];
	return {
		snapshot: {
			sessionId: "1700_abc",
			status: "idle",
			startedAt: NOW - 30 * 60_000,
			messagesWrittenAt: NOW - 10 * 60_000,
			lastMessage: { role: "assistant", content },
			...extra,
		},
		messages: [
			{ role: "user", content: [{ type: "text", text: "go" }], outputTokens: null, ts: null },
			{ role: "assistant", content, outputTokens: null, ts: null },
		],
		lastWriteAt: NOW - 10 * 60_000,
	};
}

interface HarnessOptions {
	config?: Record<string, unknown>;
	details?: Record<string, ClineSessionDetail>;
	act?: (action: RecoveryAction) => RecoveryActionResult;
	manifest?: RestartManifest | null;
	trackedChanges?: boolean;
	probeUp?: boolean;
	sleep?: (ms: number) => Promise<void>;
	consumeRecoverRequest?: () => Promise<boolean>;
	capacity?: Record<string, { maxLoadedModels: number }>;
	/** pipeline-state.json's cards before the first evaluation. */
	cards?: Record<string, Record<string, unknown>>;
}

function createHarness(options: HarnessOptions = {}) {
	const actions: RecoveryAction[] = [];
	const records: PipelineDecisionRecord[] = [];
	let cards: Record<string, Record<string, unknown>> = options.cards ?? {};
	const removedManifests: string[] = [];
	const deps: RecoveryStageDependencies = {
		locateWorktree: async (_workspacePath, entry) => `/wt/${entry.id}`,
		readSessionDetail: async (worktreePath) => options.details?.[worktreePath] ?? null,
		findRunningTool: async () => null,
		canProbe: (provider) => provider === "bedrock",
		probe: vi.fn(async () => ({ up: options.probeUp ?? true, detail: "200" })),
		act: async (_workspaceId, action) => {
			actions.push(action);
			return options.act?.(action) ?? { ok: true, status: "delivered", evidence: "hook" };
		},
		cleanGeneratedReports: async () => [],
		tagRestartWip: async (_worktree, taskId) => `preserve/${taskId}-wip-20261007T1200-restart`,
		hasTrackedChanges: async () => options.trackedChanges ?? true,
		readManifest: async () => options.manifest ?? null,
		removeManifest: async (workspaceId) => {
			removedManifests.push(workspaceId);
		},
		markManifestPlanned: async () => {},
		consumeRecoverRequest: options.consumeRecoverRequest ?? (async () => false),
		updateCards: async (_workspaceId, patches: ReadonlyMap<string, RecoveryFlowPatch>) => {
			cards = applyRecoveryPatches(cards, patches);
		},
		appendRecords: async (next) => {
			records.push(...next);
		},
		sleep: options.sleep ?? (async () => {}),
		now: () => NOW,
		log: () => {},
	};
	const stage = createRecoveryStage(deps);
	const parsed = parsePipelineConfig(
		options.config ?? { workspaces: { foo: { landing: { mode: "qa" } } }, pipeline: { recovery: { mode: "on" } } },
	);
	type SnapshotInput = Omit<PipelineWorkspaceSnapshot, "workspaceId" | "workspacePath" | "selectedAgentId">;
	const inputFor = (snapshot: SnapshotInput) => {
		const state: PipelineWorkspaceState = {
			version: 1,
			since: "2026-10-01T00:00:00.000Z",
			importedFrom: null,
			cards,
		};
		return {
			snapshot: { workspaceId: "foo", workspacePath: "/repos/foo", selectedAgentId: "claude" as const, ...snapshot },
			settings: getWorkspacePipelineSettings(parsed.config, "foo"),
			config: parsed.config,
			kitName: "default",
			state,
		};
	};
	const evaluate = async (snapshot: SnapshotInput) => {
		const result = await stage.evaluate(inputFor(snapshot));
		await stage.idle();
		return [...result, ...records.splice(0)];
	};
	return { evaluate, inputFor, stage, actions, deps, removedManifests, getCards: () => cards };
}

const prematureDetail = { "/wt/dev1": finalReply("Now let me look at the tests:") };

describe("recovery stage", () => {
	it("only logs in report mode, and only on landing-qa workspaces", async () => {
		const reportQa = createHarness({
			config: { workspaces: { foo: { landing: { mode: "qa" } } } },
			details: prematureDetail,
		});
		const records = await reportQa.evaluate({
			board: board({ review: [card("dev1")] }),
			sessions: [session("dev1")],
		});
		expect(records).toMatchObject([
			{ stage: "recovery", taskId: "dev1", outcome: "report", answer: { kind: "nudge", cause: "premature" } },
		]);
		expect(reportQa.actions).toEqual([]);
		expect(reportQa.getCards()).toEqual({});

		// The default config: landing off, recovery report. Nothing is evaluated.
		const offBoard = createHarness({ config: {}, details: prematureDetail });
		expect(
			await offBoard.evaluate({ board: board({ review: [card("dev1")] }), sessions: [session("dev1")] }),
		).toEqual([]);
		// Recovery on reaches a landing-off workspace (a provider error here), unless the workspace switched it off.
		const errorDetail = { "/wt/dev1": finalReply("The operation timed out.") };
		const on = createHarness({ config: { pipeline: { recovery: { mode: "on" } } }, details: errorDetail });
		expect(await on.evaluate({ board: board({ review: [card("dev1")] }), sessions: [session("dev1")] })).toHaveLength(
			1,
		);
		const optedOut = createHarness({
			config: { pipeline: { recovery: { mode: "on" } }, workspaces: { foo: { recovery: { enabled: false } } } },
			details: errorDetail,
		});
		expect(
			await optedOut.evaluate({ board: board({ review: [card("dev1")] }), sessions: [session("dev1")] }),
		).toEqual([]);
	});

	it("logs shadow on a shadow workspace with recovery on", async () => {
		const shadow = createHarness({
			config: {
				pipeline: { recovery: { mode: "on" } },
				workspaces: { foo: { landing: { mode: "qa" }, pipeline: { shadow: true } } },
			},
			details: prematureDetail,
		});
		const records = await shadow.evaluate({ board: board({ review: [card("dev1")] }), sessions: [session("dev1")] });
		expect(records.map((record) => record.outcome)).toEqual(["shadow"]);
		expect(shadow.actions).toEqual([]);
	});

	it("types /clear, then the card prompt, for an empty reply, and records the continue", async () => {
		const harness = createHarness({ details: { "/wt/dev1": finalReply("") } });
		const records = await harness.evaluate({ board: board({ review: [card("dev1")] }), sessions: [session("dev1")] });
		expect(
			harness.actions.map((action) => (action.kind === "deliver" ? action.text.split("\n")[0] : action.kind)),
		).toEqual(["/clear", "Prompt of dev1."]);
		expect(records[0]).toMatchObject({ outcome: "acted", note: expect.stringContaining("delivered (hook)") });
		const qaflow = harness.getCards().dev1?.qaflow as Record<string, unknown>;
		expect(qaflow.continues).toEqual([{ at: new Date(NOW).toISOString(), said: "(empty model reply)" }]);
		expect(qaflow.recoverySentAt).toBe(new Date(NOW).toISOString());
		// Next evaluation: waiting for the agent to pick it up, no second message.
		await harness.evaluate({ board: board({ review: [card("dev1")] }), sessions: [session("dev1")] });
		expect(harness.actions).toHaveLength(2);
	});

	it("does not count PTY output alone as a delivered nudge", async () => {
		const harness = createHarness({
			details: prematureDetail,
			act: () => ({ ok: true, status: "delivered", evidence: "output" }),
		});
		const records = await harness.evaluate({ board: board({ review: [card("dev1")] }), sessions: [session("dev1")] });
		expect(records[0]?.note).toContain("sent, unconfirmed (output)");
	});

	it("cancels a hung request and schedules the provider retry", async () => {
		const hung: ClineSessionDetail = {
			snapshot: {
				sessionId: "1700_abc",
				status: "running",
				startedAt: NOW - 60 * 60_000,
				messagesWrittenAt: NOW - 20 * 60_000,
				lastMessage: { role: "user", content: [{ type: "text", text: "go" }] },
			},
			messages: [{ role: "user", content: [{ type: "text", text: "go" }], outputTokens: null, ts: null }],
			lastWriteAt: NOW - 20 * 60_000,
		};
		const harness = createHarness({ details: { "/wt/dev1": hung } });
		const records = await harness.evaluate({
			board: board({ in_progress: [card("dev1")] }),
			sessions: [session("dev1", { state: "running", reviewReason: null })],
		});
		expect(harness.actions).toEqual([{ kind: "input", taskId: "dev1", data: "\u001b" }]);
		expect(records[0]).toMatchObject({ outcome: "acted", answer: { kind: "cancel_hung", followUp: "hold" } });
		const qaflow = harness.getCards().dev1?.qaflow as Record<string, unknown>;
		expect(qaflow.retryAt).toBe(new Date(NOW + 60_000).toISOString());
		expect(qaflow.hung).toMatchObject({ dir: "1700_abc" });
	});

	it("probes a held card's model in the background and records the result", async () => {
		const harness = createHarness();
		await harness.deps.updateCards(
			"foo",
			new Map([
				[
					"dev1",
					{
						outage: {
							since: new Date(NOW - 10 * 60_000).toISOString(),
							model: "m",
							warn: "503",
							ups: 0,
							lastProbe: null,
						},
					},
				],
			]),
		);
		const records = await harness.evaluate({
			board: board({ review: [card("dev1", { agentSettings: { providerId: "bedrock", modelId: "us.kimi" } })] }),
			sessions: [session("dev1")],
		});
		expect(harness.deps.probe).toHaveBeenCalledWith({ provider: "bedrock", model: "us.kimi" });
		expect(records.map((record) => record.answer)).toEqual([
			{ kind: "probe", target: { provider: "bedrock", model: "us.kimi" } },
			{ kind: "probe_result", up: true },
		]);
		expect((harness.getCards().dev1?.qaflow as Record<string, unknown>).outage).toMatchObject({ ups: 1 });
	});

	it("asks the kit's onOutage for a held card and ends the hold with a takeover request when it escalates (#8)", async () => {
		const resolved = resolveKitLayers(getDefaultKit(), getDefaultKit(), {
			"onOutage.then": "escalate",
			"onOutage.afterMin": 30,
			"escalate.to": { agent: "codex", provider: "bedrock", model: "us.moonshotai.kimi-k3" },
		});
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		const policy = createRoutingPolicy(resolved.kit, PROVISIONAL_ALLOWED);
		const outage = (minutes: number) => ({
			outage: {
				since: new Date(NOW - minutes * 60_000).toISOString(),
				model: "m",
				warn: "503",
				ups: 0,
				lastProbe: null,
			},
		});
		const devCard = card("dev1", { agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" } });
		const young = createHarness({ cards: { dev1: { qaflow: outage(10) } } });
		await young.stage.evaluate({
			...young.inputFor({ board: board({ review: [devCard] }), sessions: [session("dev1")] }),
			takeoverPolicy: policy,
		});
		await young.stage.idle();
		expect(young.deps.probe).toHaveBeenCalled();

		const held = createHarness({ cards: { dev1: { qaflow: outage(31) } } });
		const records = await held.stage.evaluate({
			...held.inputFor({ board: board({ review: [devCard] }), sessions: [session("dev1")] }),
			takeoverPolicy: policy,
		});
		expect(records.map((record) => [record.answer, record.outcome])).toEqual([
			[
				{
					kind: "takeover",
					to: { agentId: "codex", model: { provider: "bedrock", model: "us.moonshotai.kimi-k3" } },
				},
				"acted",
			],
		]);
		expect(held.deps.probe).not.toHaveBeenCalled();
		expect(held.getCards().dev1?.qaflow).toMatchObject({
			outage: null,
			takeover: { cause: "outage", requireApproval: false },
		});

		// Without the policy (no rework loop for the workspace) the hold just goes on.
		const plain = createHarness({ cards: { dev1: { qaflow: outage(31) } } });
		await plain.evaluate({ board: board({ review: [devCard] }), sessions: [session("dev1")] });
		expect(plain.deps.probe).toHaveBeenCalled();
	});

	it("resumes cards a restart orphaned, once per server start, with the WIP note", async () => {
		const harness = createHarness({ manifest: null, trackedChanges: true });
		const snapshot = {
			board: board({
				in_progress: [
					card("dev1"),
					card("qa1", { prompt: "You are the QA reviewer (round 1) for Kanban dev card dev1" }),
				],
				review: [card("done1")],
			}),
			sessions: [
				session("dev1", { state: "running", live: false, startedAt: SERVER_START - 60_000 }),
				session("qa1", { state: "running", live: false, startedAt: SERVER_START - 60_000 }),
				session("done1", { state: "awaiting_review", live: false, startedAt: SERVER_START - 60_000 }),
			],
			serverStartedAt: SERVER_START,
		};
		const records = await harness.evaluate(snapshot);
		const resume = harness.actions.find((action) => action.kind === "resume");
		// Cline has no conversation resume: a new session with the card prompt and the WIP note.
		expect(resume).toMatchObject({ kind: "resume", taskId: "dev1", agentId: "cline", continueConversation: false });
		expect(resume?.kind === "resume" && resume.prompt).toBe(`Prompt of dev1.\n\n${RESTART_WIP_NOTE}`);
		const restart = records.filter((record) => record.stage === "restart");
		expect(restart.map((record) => [record.taskId, record.outcome])).toEqual([
			[null, "none"],
			["dev1", "acted"],
			// A legacy-kit QA card (no QA gate entry) is left alone.
			["qa1", "none"],
			["dev1", "acted"],
		]);
		expect(restart.at(-1)?.note).toContain("WIP tag preserve/dev1-wip-20261007T1200-restart");
		expect((harness.getCards().dev1?.qaflow as Record<string, unknown>).orphan).toBeNull();
		// The same server start is handled once.
		const again = await harness.evaluate(snapshot);
		expect(again.filter((record) => record.stage === "restart")).toEqual([]);
		expect(harness.actions.filter((action) => action.kind === "resume")).toHaveLength(1);
	});

	it("counts a Cline card whose summary the server marked interrupted as finished when its turn had ended", async () => {
		const harness = createHarness({
			manifest: null,
			details: { "/wt/dev1": finalReply("Implemented and tested.\nSTATUS: DONE") },
		});
		const records = await harness.evaluate({
			board: board({ review: [card("dev1")] }),
			sessions: [session("dev1", { state: "interrupted", live: false, startedAt: SERVER_START - 60_000 })],
			serverStartedAt: SERVER_START,
		});
		expect(harness.actions).toEqual([]);
		expect(records.filter((record) => record.stage === "restart")).toEqual([]);
	});

	it("hands an orphaned QA card of the QA gate's to the gate with an orphan mark, and never resumes it", async () => {
		const qaGate = {
			reviewsTaskId: "dev1",
			round: 1,
			snapshot: "abcdef0123456789",
			snapshotRef: "refs/kanban/snapshots/dev1",
			outboxDir: "/tmp/kanban-qa-out/qa2",
			scratchDir: "/tmp/kanban-qa/dev1",
			baseRef: "main",
			agentId: "codex",
			model: null,
			devAgentId: "cline",
			devModel: null,
			route: null,
			status: "running",
			createdAt: SERVER_START - 120_000,
			startedAt: SERVER_START - 120_000,
		};
		const harness = createHarness({ manifest: null, cards: { qa2: { qaGate } } });
		const records = await harness.evaluate({
			board: board({ in_progress: [card("qa2", { role: "qa", reviewsTaskId: "dev1" })], review: [card("dev1")] }),
			sessions: [
				session("qa2", { agentId: "codex", state: "interrupted", live: false, startedAt: SERVER_START - 60_000 }),
				session("dev1", { state: "awaiting_review", live: false, startedAt: SERVER_START - 60_000 }),
			],
			serverStartedAt: SERVER_START,
		});
		expect(harness.actions).toEqual([]);
		expect(records.filter((record) => record.stage === "restart").at(-1)).toMatchObject({
			taskId: "qa2",
			answer: { kind: "recreate_qa" },
			outcome: "acted",
			note: expect.stringContaining(
				"handed to the QA gate, which supersedes it and queues a new QA card for dev1's snapshot abcdef01",
			),
		});
		expect((harness.getCards().qa2?.qaflow as Record<string, unknown>).orphan).toMatchObject({
			kind: "qa",
			kanbanStart: new Date(SERVER_START).toISOString(),
		});
	});

	it("resumes an orphaned Claude card by continuing its conversation, with the resume note instead of the card prompt", async () => {
		const harness = createHarness({ manifest: null, trackedChanges: true });
		const records = await harness.evaluate({
			board: board({ in_progress: [card("dev1")] }),
			sessions: [
				session("dev1", { agentId: "claude", state: "running", live: false, startedAt: SERVER_START - 60_000 }),
			],
			serverStartedAt: SERVER_START,
		});
		expect(harness.actions.find((action) => action.kind === "resume")).toEqual({
			kind: "resume",
			taskId: "dev1",
			agentId: "claude",
			prompt: RESTART_RESUME_NOTE,
			continueConversation: true,
		});
		expect(records.filter((record) => record.stage === "restart").at(-1)?.note).toContain("conversation continued");
	});

	it("only reports orphans in report mode, and keeps a failed resume marked for the user", async () => {
		const snapshot = {
			board: board({ in_progress: [card("dev1")] }),
			sessions: [session("dev1", { state: "running", live: false, startedAt: SERVER_START - 60_000 })],
			serverStartedAt: SERVER_START,
		};
		const report = createHarness({ config: { workspaces: { foo: { landing: { mode: "qa" } } } } });
		const reported = await report.evaluate(snapshot);
		expect(reported.find((record) => record.taskId === "dev1")).toMatchObject({
			stage: "restart",
			outcome: "report",
		});
		expect(report.actions).toEqual([]);

		const failing = createHarness({
			act: () => ({ ok: false, error: "no agent" }),
			manifest: { at: new Date(SERVER_START - 1000).toISOString(), cards: [] },
		});
		const records = await failing.evaluate(snapshot);
		expect(records.at(-1)).toMatchObject({
			outcome: "failed",
			note: expect.stringContaining("kanban task resume dev1"),
		});
		expect((failing.getCards().dev1?.qaflow as Record<string, unknown>).orphan).toMatchObject({ kind: "dev" });
		expect(failing.removedManifests).toEqual(["foo"]);
	});

	const orphanSnapshot = (sessions: PipelineSessionView[], cards = [card("dev1")]) => ({
		board: board({ in_progress: cards }),
		sessions,
		serverStartedAt: SERVER_START,
	});
	const dead = (taskId: string, extra: Partial<PipelineSessionView> = {}) =>
		session(taskId, { state: "running", live: false, startedAt: SERVER_START - 60_000, ...extra });

	it("clears the orphan mark of a card whose resume failed once the user restarts it by hand", async () => {
		const harness = createHarness({
			act: (action) => (action.kind === "resume" ? { ok: false, error: "no agent" } : { ok: true }),
		});
		await harness.evaluate(orphanSnapshot([dead("dev1")]));
		expect((harness.getCards().dev1?.qaflow as Record<string, unknown>).orphan).toMatchObject({ kind: "dev" });

		// Restarted by hand: a live session started by this server.
		await harness.evaluate(
			orphanSnapshot([session("dev1", { state: "running", live: true, startedAt: SERVER_START + 1000 })]),
		);
		expect((harness.getCards().dev1?.qaflow as Record<string, unknown>).orphan).toBeNull();
	});

	it("gives up on a capacity-held resume, and a hand restart then clears the mark", async () => {
		const lemonade = (id: string) =>
			card(id, { agentSettings: { providerId: "lemonade", modelId: id === "dev1" ? "glm" : "qwen" } });
		const harness = createHarness();
		const snapshot = {
			board: board({ in_progress: [lemonade("dev1"), lemonade("other")] }),
			sessions: [dead("dev1"), session("other", { state: "running", live: true, startedAt: SERVER_START + 1 })],
			serverStartedAt: SERVER_START,
		};
		const records = await harness.evaluate(snapshot);
		expect(harness.actions.filter((action) => action.kind === "resume")).toEqual([]);
		expect(records.at(-1)).toMatchObject({
			outcome: "failed",
			note: expect.stringContaining("lemonade holds 1 model(s)"),
		});
		expect((harness.getCards().dev1?.qaflow as Record<string, unknown>).orphan).toMatchObject({ kind: "dev" });

		snapshot.sessions[0] = session("dev1", { state: "running", live: true, startedAt: SERVER_START + 2000 });
		await harness.evaluate(snapshot);
		expect((harness.getCards().dev1?.qaflow as Record<string, unknown>).orphan).toBeNull();
	});

	it("waits out PID pressure before a restart resume, logged once, and resumes once it clears", async () => {
		const sleeps: number[] = [];
		const pressured = { ...orphanSnapshot([dead("dev1")]), pidPressure: true };
		let harness: ReturnType<typeof createHarness> | null = null;
		harness = createHarness({
			sleep: async (ms) => {
				sleeps.push(ms);
				expect(harness?.actions.filter((action) => action.kind === "resume")).toEqual([]);
				// The next snapshot says the pressure cleared.
				if (sleeps.length === 3 && harness) {
					await harness.stage.evaluate(harness.inputFor({ ...pressured, pidPressure: false }));
				}
			},
		});
		const records = await harness.evaluate(pressured);
		expect(sleeps).toEqual([30_000, 30_000, 30_000]);
		const restart = records
			.filter((record) => record.stage === "restart" && record.taskId === "dev1")
			.map((record) => [record.outcome, record.note]);
		expect(restart).toEqual([
			["acted", expect.stringContaining("orphaned (in_progress)")],
			["none", "PID pressure; waiting before resuming"],
			["acted", expect.stringContaining("resumed on")],
		]);
		expect(harness.actions.filter((action) => action.kind === "resume").map((action) => action.taskId)).toEqual([
			"dev1",
		]);
	});

	it("does not resume a card that went live between the plan and its turn", async () => {
		const sessions = [dead("dev1"), dead("dev2")];
		const harness = createHarness({
			// The gap between resumes: meanwhile the user restarted dev2.
			sleep: async () => {
				sessions[1] = session("dev2", { state: "running", live: true, startedAt: SERVER_START + 5000 });
			},
		});
		const snapshot = orphanSnapshot(sessions, [card("dev1"), card("dev2")]);
		const records = await harness.evaluate(snapshot);
		expect(harness.actions.filter((action) => action.kind === "resume").map((action) => action.taskId)).toEqual([
			"dev1",
		]);
		expect(
			records.find(
				(record) =>
					record.taskId === "dev2" &&
					record.answer &&
					(record.answer as { kind: string }).kind === "resume" &&
					record.outcome === "none",
			)?.note,
		).toBe("has a live session again (restarted meanwhile); not resumed");
		expect((harness.getCards().dev2?.qaflow as Record<string, unknown>).orphan).toBeNull();
	});

	it("keeps a recover request queued while a resume runs", async () => {
		let release: () => void = () => {};
		const consumeRecoverRequest = vi.fn(async () => true);
		const harness = createHarness({
			consumeRecoverRequest,
			sleep: async () =>
				await new Promise<void>((resolve) => {
					release = resolve;
				}),
		});
		const snapshot = orphanSnapshot([dead("dev1"), dead("dev2")], [card("dev1"), card("dev2")]);
		const first = harness.evaluate(snapshot); // its second resume waits in sleep()
		await vi.waitFor(() => expect(harness.actions.filter((action) => action.kind === "resume")).toHaveLength(1));
		const callsBefore = consumeRecoverRequest.mock.calls.length;
		const second = harness.stage.evaluate(harness.inputFor(snapshot));
		await second;
		expect(consumeRecoverRequest.mock.calls.length).toBe(callsBefore);
		release();
		await first;
	});

	const PREVIOUS_START = SERVER_START - 3_600_000;

	it("drops a used restart manifest in report mode too", async () => {
		const harness = createHarness({
			config: { workspaces: { foo: { landing: { mode: "qa" } } } },
			manifest: {
				at: new Date(SERVER_START - 1000).toISOString(),
				kanbanStart: new Date(PREVIOUS_START).toISOString(),
				cards: [{ id: "dev1", column: "in_progress" }],
			},
		});
		const records = await harness.evaluate({
			...orphanSnapshot([dead("dev1")]),
			previousServerStartedAt: PREVIOUS_START,
		});
		expect(records[0]?.note).toContain("restart manifest of");
		expect(harness.actions).toEqual([]);
		expect(harness.removedManifests).toEqual(["foo"]);
	});

	it("after a crash (no prepare, no shutdown) resumes the cards of the crashed server's periodic manifest", async () => {
		await withTemporaryKanbanHome(async () => {
			const crashBoard = board({ in_progress: [card("dev1")], review: [card("dev2"), card("dev3")] });
			const running = { state: "running" as const, modelId: null };
			// The previous server's last periodic write, 4 minutes before it was killed (OOM, power loss).
			const lastWriteAt = SERVER_START - 4 * 60_000;
			const crashed = createRestartManifestWriter({
				listWorkspaceIds: () => ["foo"],
				loadWorkspace: async () => ({
					board: crashBoard,
					sessions: { dev1: running, dev2: running, dev3: running },
				}),
				serverStartedAt: PREVIOUS_START,
				previousServerStartedAt: null,
				now: () => lastWriteAt,
			});
			await crashed.writeAll("periodic");
			// Killed: `crashed` is never closed, no shutdown write, no `kanban restart prepare`.

			// The new server's own writer leaves that manifest to restart recovery.
			const writer = createRestartManifestWriter({
				listWorkspaceIds: () => ["foo"],
				loadWorkspace: async () => ({ board: crashBoard, sessions: {} }),
				serverStartedAt: SERVER_START,
				previousServerStartedAt: PREVIOUS_START,
				now: () => NOW,
			});
			await writer.writeAll("periodic");
			expect((await readRestartManifest("foo"))?.kanbanStart).toBe(new Date(PREVIOUS_START).toISOString());

			let asked = false;
			const harness = createHarness({ consumeRecoverRequest: async () => asked });
			harness.deps.readManifest = readRestartManifest;
			harness.deps.removeManifest = removeRestartManifest;
			harness.deps.markManifestPlanned = markRestartManifestPlanned;
			// sessions.json after the crash: dev1's summary still "running"; dev2 has none (only the manifest knows it
			// was mid-turn); dev3's turn ended after the last periodic write.
			const snapshot = {
				board: crashBoard,
				sessions: [dead("dev1"), dead("dev3", { state: "awaiting_review", stateChangedAt: lastWriteAt + 60_000 })],
				serverStartedAt: SERVER_START,
				previousServerStartedAt: PREVIOUS_START,
			};
			const records = await harness.evaluate(snapshot);
			expect(records[0]?.note).toContain(`restart manifest of ${new Date(lastWriteAt).toISOString()}`);
			expect(records[0]?.note).toContain("2 orphaned card(s)");
			expect(harness.actions.filter((action) => action.kind === "resume").map((action) => action.taskId)).toEqual([
				"dev1",
				"dev2",
			]);
			// Used once: gone, so the next start never replays it.
			expect(existsSync(getRestartManifestPath("foo"))).toBe(false);

			// The new server's own manifest is for the next start: a later check leaves it alone.
			await writer.writeAll("periodic");
			const own = await readRestartManifest("foo");
			expect(own).toMatchObject({ kanbanStart: new Date(SERVER_START).toISOString(), source: "periodic" });
			asked = true;
			const again = await harness.evaluate(snapshot);
			expect(again[0]?.note).not.toContain("dropped a stale restart manifest");
			expect(await readRestartManifest("foo")).toEqual(own);
			await writer.close();
		});
	});

	it("tags fresh after a crash 3 h after a `kanban restart prepare` that no restart followed", async () => {
		await withTemporaryKanbanHome(async () => {
			const crashedStart = SERVER_START - 6 * 3_600_000;
			const crashBoard = board({ in_progress: [card("dev1")] });
			const preparedAt = SERVER_START - 3 * 3_600_000;
			await writeRestartManifest("foo", {
				at: new Date(preparedAt).toISOString(),
				kanbanStart: new Date(crashedStart).toISOString(),
				source: "prepare",
				cards: [{ id: "dev1", column: "in_progress", wipTag: "preserve/dev1-wip-20261007T0900-restart" }],
			});
			// The crashed server went on writing its own manifests after the prepare hold, until 4 min before the crash.
			let clock = preparedAt + 31 * 60_000;
			const crashed = createRestartManifestWriter({
				listWorkspaceIds: () => ["foo"],
				loadWorkspace: async () => ({ board: crashBoard, sessions: { dev1: { state: "running", modelId: null } } }),
				serverStartedAt: crashedStart,
				previousServerStartedAt: null,
				now: () => clock,
			});
			await crashed.writeAll("periodic");
			clock = SERVER_START - 4 * 60_000;
			await crashed.writeAll("periodic");
			expect(await readRestartManifest("foo")).toMatchObject({ source: "periodic", cards: [{ wipTag: null }] });

			const harness = createHarness();
			harness.deps.readManifest = readRestartManifest;
			harness.deps.removeManifest = removeRestartManifest;
			const mark = vi.fn(markRestartManifestPlanned);
			harness.deps.markManifestPlanned = mark;
			const records = await harness.evaluate({
				board: crashBoard,
				sessions: [dead("dev1")],
				serverStartedAt: SERVER_START,
				previousServerStartedAt: crashedStart,
			});
			expect(harness.actions.filter((action) => action.kind === "resume").map((action) => action.taskId)).toEqual([
				"dev1",
			]);
			// The harness's tagRestartWip: the worktree as the crash left it, not the 3-hour-old prepare tag.
			const resumed = records.find(
				(record) => record.taskId === "dev1" && record.outcome === "acted" && record.note?.startsWith("resumed"),
			);
			expect(resumed?.note).toContain("WIP tag preserve/dev1-wip-20261007T1200-restart");
			expect(resumed?.note).not.toContain("20261007T0900");
			// Planned before the resumes, so the new server's writer stops holding back; removed once they are done.
			expect(mark).toHaveBeenCalledWith("foo", expect.objectContaining({ source: "periodic" }));
			expect(await readRestartManifest("foo")).toBeNull();
		});
	});

	it("never replays a stale manifest (a landing-off workspace's, weeks old) when recovery is switched on", async () => {
		const weeksAgo = new Date(PREVIOUS_START - 21 * 86_400_000).toISOString();
		const harness = createHarness({
			config: { pipeline: { recovery: { mode: "on" } } },
			manifest: {
				at: weeksAgo,
				kanbanStart: weeksAgo,
				cards: [{ id: "dev1", column: "review", wipTag: "old-tag" }],
			},
		});
		// dev1 finished long ago; only the stale manifest would call it an orphan.
		const records = await harness.evaluate({
			board: board({ review: [card("dev1")] }),
			sessions: [session("dev1", { state: "awaiting_review", live: false, startedAt: SERVER_START - 60_000 })],
			serverStartedAt: SERVER_START,
			previousServerStartedAt: PREVIOUS_START,
		});
		expect(harness.actions.filter((action) => action.kind === "resume")).toEqual([]);
		expect(harness.removedManifests).toEqual(["foo"]);
		expect(records[0]?.note).toContain(`dropped a stale restart manifest of ${weeksAgo}`);
		expect(harness.getCards().dev1).toBeUndefined();
	});

	it("keeps the mark a fresh plan just wrote, even over an old mark from an earlier start", async () => {
		const harness = createHarness({
			act: (action) => (action.kind === "resume" ? { ok: false, error: "no agent" } : { ok: true }),
		});
		const oldStart = new Date(PREVIOUS_START).toISOString();
		await harness.deps.updateCards(
			"foo",
			new Map([["dev1", { orphan: { at: "x", kanbanStart: oldStart, kind: "dev" } }]]),
		);
		await harness.evaluate(orphanSnapshot([dead("dev1")]));
		// The evaluation that planned it read the state from before its own mark; it must not wipe it.
		expect((harness.getCards().dev1?.qaflow as Record<string, unknown>).orphan).toMatchObject({
			kanbanStart: new Date(SERVER_START).toISOString(),
			kind: "dev",
		});
	});

	it("continues a premature stop only on landing-qa workspaces; crash nudges run everywhere", async () => {
		const offBoard = createHarness({ config: { pipeline: { recovery: { mode: "on" } } }, details: prematureDetail });
		expect(
			await offBoard.evaluate({ board: board({ review: [card("dev1")] }), sessions: [session("dev1")] }),
		).toEqual([]);
		const crash = createHarness({
			config: { pipeline: { recovery: { mode: "on" } } },
			details: { "/wt/dev1": finalReply("The operation timed out.") },
		});
		const records = await crash.evaluate({ board: board({ review: [card("dev1")] }), sessions: [session("dev1")] });
		expect(records[0]).toMatchObject({ answer: { kind: "hold" }, outcome: "acted" });
	});
});
