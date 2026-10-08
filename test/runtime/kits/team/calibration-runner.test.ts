import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardColumnId, RuntimeTaskSessionSummary } from "../../../../src/core/api-contract";
import { resolveCardRole } from "../../../../src/core/card-role";
import type { QaPromptParts } from "../../../../src/kits/policy";
import {
	CALIBRATION_POLL_MS,
	type CalibrationBoardState,
	type CalibrationCardInput,
	type CalibrationDependencies,
	IMAGE_REJECTION_REASON,
	runCalibration,
} from "../../../../src/kits/team/calibration/calibration-runner";
import { type CalibrationSpec, parseCalibrationSpec } from "../../../../src/kits/team/calibration/calibration-spec";
import type { CalibrationState } from "../../../../src/kits/team/calibration/calibration-state";
import { writeCalibrationState } from "../../../../src/kits/team/calibration/calibration-state";
import type { QaVerdict, QaVerdictRead } from "../../../../src/pipeline/qa-verdict";
import { readCalibrationRunIds } from "../../../../src/pipeline/watchdog/workspace-data";
import { type CalibrationPaths, getCalibrationPaths } from "../../../../src/state/kanban-home";
import { type AgentRunSignals, createAgentRunSignals } from "../../../../src/terminal/agent-run-signals";
import { createClineSessionFileReader } from "../../../../src/terminal/cline-session-files";
import { textMessage, toolResult, toolUse, writeFakeClineSession } from "../../../utilities/fake-cline-sessions";
import { createTempDir } from "../../../utilities/temp-dir";
import { createBoard, createCard } from "../../../utilities/workspace-state-store";

const T0 = Date.parse("2026-10-07T10:00:00Z");
const PARTS: QaPromptParts = {
	rules: [],
	blurb: "",
	notes: { screenshotFallback: "", knownBaseIssues: "", dbSetup: "" },
	serversScript: null,
};

function verdictOf(verdict: QaVerdict["verdict"]): QaVerdict {
	return {
		verdict,
		scores: { spec: 4, correctness: 4, tests: 3, ux: null, code: 4, process: 4 },
		blocking: verdict === "FAIL" ? ["login is broken"] : [],
		visual: { status: "ok", artifacts: [], consoleErrors: 0 },
		notes: `${verdict} notes`,
		log: "- ok",
	};
}

function createSpec(overrides: Record<string, unknown> = {}): CalibrationSpec {
	return parseCalibrationSpec({
		name: "qa-models-t1",
		workspace: "foo",
		parallel: 2,
		timeoutMin: 60,
		sets: [
			{ id: "A", ref: "0d1b26d", base: "2ca0882", fromCard: "f80db", expect: "FAIL", note: "f80db known bad" },
			{ id: "B", ref: "0167450", base: "1c8c397", fromCard: "2c0d7", expect: "PASS" },
		],
		models: [
			{ key: "sol", agent: "codex" },
			{
				key: "haiku",
				agent: "cline",
				provider: "bedrock",
				model: "us.anthropic.claude-haiku-4-5",
				rules: ["drive"],
			},
		],
		...overrides,
	});
}

interface SimCard {
	id: string;
	input: CalibrationCardInput;
	column: RuntimeBoardColumnId;
	session: Partial<RuntimeTaskSessionSummary> | null;
	createdAt: number;
}

interface Harness {
	cards: SimCard[];
	verdicts: Map<string, QaVerdictRead>;
	log: string[];
	delivered: Array<{ taskId: string; text: string; at: number }>;
	wakes: string[];
	scratchStops: string[][];
	refs: Map<string, string>;
	finished: string[];
	now: () => number;
	/** The agent ends its turn (Review), optionally after writing a verdict. */
	endTurn: (card: SimCard, verdict?: QaVerdictRead) => void;
}

/** A fake Kanban server and clock: sleep() advances time, and `onPoll` lets a test play the agents. */
function createHarness(options: {
	spec: CalibrationSpec;
	paths: CalibrationPaths;
	onPoll?: (harness: Harness) => void;
	signals?: Partial<AgentRunSignals>;
	pidPressure?: () => { pressure: boolean; brownout: boolean };
	measure?: CalibrationDependencies["measure"];
	/** The Kanban server can't be reached for this poll. */
	boardDown?: (harness: Harness) => boolean;
}) {
	let now = T0;
	const cards: SimCard[] = [];
	const verdicts = new Map<string, QaVerdictRead>();
	const log: string[] = [];
	const delivered: Array<{ taskId: string; text: string; at: number }> = [];
	const wakes: string[] = [];
	const scratchStops: string[][] = [];
	const refs = new Map<string, string>();
	const finished: string[] = [];
	const outDirOf = (card: SimCard) => /OUT=(\S+)\./u.exec(card.input.prompt)?.[1] ?? "";
	const harness: Harness = {
		cards,
		verdicts,
		log,
		delivered,
		wakes,
		scratchStops,
		refs,
		finished,
		now: () => now,
		endTurn: (card: SimCard, verdict?: QaVerdictRead) => {
			card.column = "review";
			card.session = { ...card.session, state: "awaiting_review" };
			if (verdict) {
				verdicts.set(outDirOf(card), verdict);
			}
		},
	};

	const signals: AgentRunSignals = {
		isSessionRunning: async () => null,
		findToolCallLoop: async () => null,
		countToolUse: async () => null,
		hasImageRejection: async () => null,
		hasStartedTurn: async () => null,
		isSignedIn: async () => null,
		...options.signals,
	};
	const deps: CalibrationDependencies = {
		board: {
			read: async (): Promise<CalibrationBoardState> => {
				if (options.boardDown?.(harness)) {
					throw new Error("connect ECONNREFUSED 127.0.0.1:3484");
				}
				options.onPoll?.(harness);
				const byColumn: Partial<Record<RuntimeBoardColumnId, ReturnType<typeof createCard>[]>> = {};
				const sessions: Record<string, RuntimeTaskSessionSummary> = {};
				for (const card of cards) {
					byColumn[card.column] = [
						...(byColumn[card.column] ?? []),
						createCard({ id: card.id, title: card.input.title, prompt: card.input.prompt, role: "calibration" }),
					];
					if (card.session) {
						sessions[card.id] = {
							taskId: card.id,
							state: "running",
							agentId: card.input.agentId,
							workspacePath: `/worktrees/${card.id}/repo`,
							pid: null,
							startedAt: T0,
							updatedAt: now,
							lastOutputAt: null,
							reviewReason: null,
							exitCode: null,
							lastHookAt: null,
							latestHookActivity: null,
							modelId: null,
							reasoningEffort: null,
							...card.session,
						} as RuntimeTaskSessionSummary;
					}
				}
				return { board: createBoard(byColumn), sessions };
			},
			createTask: async (input) => {
				const id = `c${String(cards.length + 1).padStart(4, "0")}`;
				cards.push({ id, input, column: "backlog", session: null, createdAt: now });
				return id;
			},
			startTask: async (taskId) => {
				const card = cards.find((entry) => entry.id === taskId);
				if (card) {
					card.column = "in_progress";
					card.session = { state: "running" };
				}
			},
			finishTask: async (taskId) => {
				finished.push(taskId);
				const card = cards.find((entry) => entry.id === taskId);
				if (card) {
					card.column = "trash";
					card.session = null;
				}
			},
			deliverInput: async (taskId, text) => {
				delivered.push({ taskId, text, at: now });
				return { ok: true };
			},
		},
		signals,
		readDevPrompt: async (taskId) => (taskId === "missing" ? null : `Build the thing for ${taskId}.`),
		updateRef: async (ref, target) => {
			refs.set(ref, target);
		},
		resetOutbox: async (dir) => {
			verdicts.delete(dir);
		},
		readVerdict: async (dir) => verdicts.get(dir) ?? { kind: "missing" },
		measure: options.measure ?? (async () => ({ costUSD: 1.25, tokens: { in: 1000, out: 100, cacheRead: 0 } })),
		stopScratchProcesses: async (dirs) => {
			scratchStops.push(dirs);
			return 1;
		},
		readPidPressure: async () => options.pidPressure?.() ?? { pressure: false, brownout: false },
		findWorktreePath: async (taskId) => `/worktrees/${taskId}/repo`,
		wakeOrchestrator: async (issue) => {
			wakes.push(issue);
		},
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		log: (message) => log.push(message),
	};
	const run = async () =>
		await runCalibration(
			{
				spec: options.spec,
				paths: options.paths,
				repoPath: "/projects/foo",
				outboxRoot: `/tmp/qa-out/cal/${options.spec.name}`,
				scratchRoot: "/tmp/qa-scratch",
				promptParts: () => PARTS,
				kanbanHome: "~/.kanban",
			},
			deps,
		);
	return { harness, run };
}

const tempDirs: Array<{ cleanup: () => void }> = [];
const createdPaths: CalibrationPaths[] = [];
function createPaths(name = "qa-models-t1"): CalibrationPaths {
	const temp = createTempDir("kanban-calibration-");
	tempDirs.push(temp);
	const paths = getCalibrationPaths("foo", name, temp.path);
	createdPaths.push(paths);
	return paths;
}

afterEach(() => {
	for (const temp of tempDirs.splice(0)) {
		temp.cleanup();
	}
	vi.restoreAllMocks();
});

describe("runCalibration", () => {
	it("runs set by set in waves, records verdicts, moves cards to Done and wakes the orchestrator", async () => {
		const spec = createSpec();
		const paths = createPaths();
		const { harness, run } = createHarness({
			spec,
			paths,
			onPoll: (h) => {
				for (const card of h.cards) {
					if (card.column === "in_progress") {
						h.endTurn(card, {
							kind: "ok",
							verdict: verdictOf(card.input.title.includes(" A ") ? "FAIL" : "PASS"),
						});
					}
				}
			},
		});
		// The second wave (set B) must not start before the first (set A) is finished.
		const state = await run();
		const titles = harness.cards.map((card) => card.input.title);
		expect(titles).toEqual([
			"QA-CAL A sol: f80db known bad",
			"QA-CAL A haiku: f80db known bad",
			"QA-CAL B sol: 2c0d7",
			"QA-CAL B haiku: 2c0d7",
		]);
		expect(harness.log.findIndex((line) => line.startsWith("B-sol: card"))).toBeGreaterThan(
			harness.log.findIndex((line) => line.startsWith("A-haiku: FAIL")),
		);
		expect(state.runs["A-sol"]).toMatchObject({ verdict: "FAIL", why: "verdict written", costUSD: 1.25 });
		expect(state.runs["B-haiku"]).toMatchObject({ verdict: "PASS", blocking: [] });
		expect(state.finishedAt).toBeTruthy();
		expect(harness.finished).toHaveLength(4);
		expect(harness.refs.get("refs/kanban/calibration/qa-models-t1-A")).toBe("0d1b26d");
		expect(harness.scratchStops[0]).toEqual([
			"/tmp/qa-scratch/cal-qa-models-t1-A-sol",
			"/tmp/qa-scratch/cal-qa-models-t1-A-sol-2ca0882",
		]);
		expect(harness.wakes).toEqual([
			`QA calibration qa-models-t1 finished: judge it as ${paths.readme} says (results ${paths.resultsMd}).`,
		]);
		const results = await readFile(paths.resultsMd, "utf8");
		expect(results).toContain("| A | FAIL | sol | FAIL | 4/4/3/-/4/4 | ok | 1 |");
		expect(JSON.parse(await readFile(paths.resultsJson, "utf8")).runs["B-sol"].verdict).toBe("PASS");
		// Finished: prune-done may delete its cards now; the watchdog still knows them as calibration cards.
		const calibrationDir = join(paths.dir, "..");
		expect(await readCalibrationRunIds(calibrationDir, { onlyUnfinished: true })).toEqual(new Set());
		expect((await readCalibrationRunIds(calibrationDir)).size).toBe(4);
	});

	it("creates calibration cards with the agent, model and calibration QA prompt of each model", async () => {
		const spec = createSpec({ sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }] });
		const { harness, run } = createHarness({
			spec,
			paths: createPaths(),
			onPoll: (h) => {
				for (const card of h.cards) {
					h.endTurn(card, { kind: "ok", verdict: verdictOf("PASS") });
				}
			},
		});
		await run();
		const [sol, haiku] = harness.cards;
		expect(sol?.input).toMatchObject({ agentId: "codex", agentSettings: undefined });
		expect(haiku?.input).toMatchObject({
			agentId: "cline",
			agentSettings: { providerId: "bedrock", modelId: "us.anthropic.claude-haiku-4-5" },
		});
		const prompt = haiku?.input.prompt ?? "";
		expect(
			prompt.startsWith(
				'You are the QA reviewer (calibration qa-models-t1 A-haiku) for a Kanban dev card ("f80db")',
			),
		).toBe(true);
		expect(prompt).toContain("snapshotted at refs/kanban/calibration/qa-models-t1-A in /projects/foo");
		expect(prompt).toContain("git -C /projects/foo diff b1...refs/kanban/calibration/qa-models-t1-A");
		expect(prompt).toContain("OUT=/tmp/qa-out/cal/qa-models-t1/A-haiku.");
		expect(prompt).toContain("Build the thing for f80db.");
		// Even a card that lost its role field reads as a calibration card (the legacy markers).
		expect(resolveCardRole({ title: haiku?.input.title, prompt })).toBe("calibration");
	});

	it("resumes from state.json: started runs are watched, not created again", async () => {
		const spec = createSpec({ sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }] });
		const paths = createPaths();
		const resumed: CalibrationState = {
			runs: {
				"A-sol": {
					id: "c0001",
					outDir: "/tmp/qa-out/cal/qa-models-t1/A-sol",
					scratch: "/tmp/qa-scratch/cal-qa-models-t1-A-sol",
					base: "b1",
					startedAt: T0 - 60_000,
					nudges: 0,
				},
				"A-haiku": { done: "2026-10-07T09:00:00.000Z", verdict: "PASS", why: "verdict written" },
			},
		};
		await writeCalibrationState(paths.state, resumed);
		const { harness, run } = createHarness({
			spec,
			paths,
			onPoll: (h) => {
				h.verdicts.set("/tmp/qa-out/cal/qa-models-t1/A-sol", { kind: "ok", verdict: verdictOf("FAIL") });
			},
		});
		// The card the old runner started is still on the board (in Review).
		harness.cards.push({
			id: "c0001",
			input: { title: "QA-CAL A sol: f80db", prompt: "", agentId: "codex" },
			column: "review",
			session: { state: "awaiting_review" },
			createdAt: T0 - 60_000,
		});
		const state = await run();
		expect(harness.cards).toHaveLength(1);
		expect(state.runs["A-sol"]).toMatchObject({ verdict: "FAIL", wallMin: 1.5 });
		expect(state.runs["A-haiku"]?.verdict).toBe("PASS");
	});

	it("holds a wave while PID pressure is flagged, and doesn't nudge during a brownout", async () => {
		const spec = createSpec({
			sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }],
			models: [{ key: "sol", agent: "codex" }],
			maxNudges: 1,
		});
		const pressureUntil = T0 + 5 * 60_000;
		let brownoutUntil = 0;
		const { harness, run } = createHarness({
			spec,
			paths: createPaths(),
			pidPressure: () => ({ pressure: harness.now() < pressureUntil, brownout: harness.now() < brownoutUntil }),
			onPoll: (h) => {
				const card = h.cards[0];
				if (card?.column === "in_progress") {
					h.endTurn(card);
					brownoutUntil = h.now() + 10 * 60_000;
				}
			},
		});
		await run();
		expect(harness.log.filter((line) => line === "PID pressure: holding the next wave")).toHaveLength(1);
		expect(harness.cards).toHaveLength(1);
		expect(harness.cards[0]?.createdAt).toBeGreaterThanOrEqual(pressureUntil);
		expect(harness.delivered).toHaveLength(1);
		expect(harness.delivered[0]?.at).toBeGreaterThanOrEqual(brownoutUntil);
	});

	it("nudges a card that stopped without a verdict, then ends it DNF after maxNudges", async () => {
		const spec = createSpec({
			sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }],
			models: [{ key: "sol", agent: "codex" }],
			maxNudges: 2,
		});
		const { harness, run } = createHarness({
			spec,
			paths: createPaths(),
			onPoll: (h) => {
				for (const card of h.cards) {
					if (card.column !== "trash") {
						h.endTurn(card);
					}
				}
			},
		});
		const state = await run();
		expect(harness.delivered).toHaveLength(2);
		expect(harness.delivered[0]?.text).toBe(
			"You stopped without writing /tmp/qa-out/cal/qa-models-t1/A-sol/verdict.json. Continue the QA review from where you are and finish by writing that file exactly as step 6 describes (STALLED with the reason if you truly cannot finish).",
		);
		expect(state.runs["A-sol"]).toMatchObject({
			verdict: "DNF",
			why: "stopped without a verdict after 2 nudges",
			nudges: 2,
		});
		// Nudges are more than a minute apart.
		expect((harness.delivered[1]?.at ?? 0) - (harness.delivered[0]?.at ?? 0)).toBeGreaterThan(60_000);
	});

	it("quotes an unusable verdict.json in the nudge and keeps the first error for the judge", async () => {
		const spec = createSpec({
			sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }],
			models: [{ key: "glm", agent: "cline", provider: "lemonade", model: "glm" }],
			maxNudges: 1,
		});
		const { harness, run } = createHarness({
			spec,
			paths: createPaths(),
			onPoll: (h) => {
				const card = h.cards[0];
				if (card && card.column !== "trash") {
					h.endTurn(card, { kind: "invalid", error: "invalid JSON (Bad control character)" });
				}
			},
		});
		const state = await run();
		expect(harness.delivered[0]?.text).toBe(
			'/tmp/qa-out/cal/qa-models-t1/A-glm/verdict.json exists but is not usable: invalid JSON (Bad control character). Rewrite it as valid JSON (escape newlines inside strings as \\n, or make "log" an array of strings). Then stop.',
		);
		expect(state.runs["A-glm"]).toMatchObject({
			verdict: "DNF",
			badVerdict: "invalid JSON (Bad control character)",
			why: "verdict.json unusable (invalid JSON (Bad control character)) after 1 nudges",
		});
	});

	describe("image rejection (issue #7)", () => {
		const REJECTION = "This model doesn't support the image field for user messages. Remove image and try again.";
		const WORKTREE = "/worktrees/c0001/repo";

		/** A Cline model whose session files (real reader, fake files) play the agent: session `n` ends on `last`. */
		function createImageHarness(sessions: Array<"rejection" | "stop" | "verdict">) {
			const spec = createSpec({
				sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }],
				models: [{ key: "sol6", agent: "cline", provider: "bedrock", model: "us.openai.gpt-6-sol" }],
				maxNudges: 6,
			});
			const temp = createTempDir("kanban-cline-sessions-");
			tempDirs.push(temp);
			const signals = createAgentRunSignals({
				clineReader: createClineSessionFileReader(),
				clineSessionsPath: temp.path,
			});
			let written = 0;
			const writeSession = (index: number, at: number) => {
				const kind = sessions[index] ?? "stop";
				const last =
					kind === "rejection"
						? textMessage("assistant", REJECTION, at + 3)
						: textMessage("assistant", "I looked at the page.", at + 3);
				writeFakeClineSession(temp.path, {
					sessionId: `${at}_s${index}`,
					cwd: WORKTREE,
					status: "idle",
					startedAt: at,
					messages: [
						textMessage("user", "review it", at),
						toolUse("read_files", at + 1),
						toolResult(at + 2),
						last,
					],
				});
				return kind;
			};
			const created = createHarness({
				spec,
				paths: createPaths(),
				signals,
				onPoll: (h) => {
					const card = h.cards[0];
					if (!card || card.column === "trash") {
						return;
					}
					// One session per conversation: the first at the start, then one after each /clear.
					const clears = h.delivered.filter((entry) => entry.text === "/clear").length;
					if (written <= clears) {
						const kind = writeSession(written, h.now());
						written += 1;
						h.endTurn(card, kind === "verdict" ? { kind: "ok", verdict: verdictOf("PASS") } : undefined);
					} else if (card.column !== "review") {
						h.endTurn(card);
					}
				},
			});
			return created;
		}

		it("answers a rejection with the image recovery: /clear, then the run prompt with the no-images note", async () => {
			const { harness, run } = createImageHarness(["rejection", "verdict"]);
			const state = await run();
			const prompt = harness.cards[0]?.input.prompt ?? "";
			expect(harness.delivered.map((entry) => entry.text)).toEqual([
				"/clear",
				`${prompt}\n\nYour previous conversation was cleared: you opened an image file, your model doesn't accept images, and every later request failed. Your work so far is in this worktree (git status / git diff): continue the task from there. Never read image files (.png/.jpg/.gif/.webp); check screenshots through the screenshot tool's text report (status, console, outline) instead.`,
			]);
			// The prompt follows the clear once the TUI has started its new conversation.
			expect((harness.delivered[1]?.at ?? 0) - (harness.delivered[0]?.at ?? 0)).toBe(1_500);
			expect(state.runs["A-sol6"]).toMatchObject({ verdict: "PASS", nudges: 1, imageRecoveries: 1 });
		});

		it("ends the run DNF at once when the rejection repeats right after the image recovery", async () => {
			const { harness, run } = createImageHarness(["rejection", "rejection"]);
			const state = await run();
			expect(harness.delivered.filter((entry) => entry.text === "/clear")).toHaveLength(1);
			expect(harness.delivered).toHaveLength(2);
			expect(state.runs["A-sol6"]).toMatchObject({ verdict: "DNF", why: IMAGE_REJECTION_REASON, nudges: 1 });
			expect(harness.finished).toEqual(["c0001"]);
			const saved = JSON.parse(await readFile(createdPaths.at(-1)?.state ?? "", "utf8")) as CalibrationState;
			expect(saved.runs["A-sol6"]?.why).toBe("model rejects images");
			expect(await readFile(createdPaths.at(-1)?.resultsMd ?? "", "utf8")).toContain("| DNF |");
			expect(await readFile(createdPaths.at(-1)?.resultsMd ?? "", "utf8")).toContain("model rejects images");
		});

		it("still sends the usual nudges to a Cline run that stopped without a rejection", async () => {
			const { harness, run } = createImageHarness(["stop"]);
			const state = await run();
			expect(harness.delivered).toHaveLength(6);
			expect(harness.delivered.every((entry) => entry.text.startsWith("You stopped without writing"))).toBe(true);
			expect(state.runs["A-sol6"]).toMatchObject({
				verdict: "DNF",
				why: "stopped without a verdict after 6 nudges",
			});
			expect(state.runs["A-sol6"]?.imageRecoveries).toBeUndefined();
		});
	});

	it("ends a run with no native tool calls after 2 nudges (tool calls written as text)", async () => {
		const spec = createSpec({
			sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }],
			models: [{ key: "devstral", agent: "cline", provider: "lemonade", model: "devstral" }],
			maxNudges: 6,
		});
		const countToolUse = vi.fn(async () => ({ native: 0, textual: 7, turns: 7 }));
		const { harness, run } = createHarness({
			spec,
			paths: createPaths(),
			signals: { countToolUse },
			onPoll: (h) => {
				const card = h.cards[0];
				if (card && card.column !== "trash") {
					h.endTurn(card);
				}
			},
		});
		const state = await run();
		expect(harness.delivered).toHaveLength(2);
		expect(countToolUse).toHaveBeenCalledWith("cline", "/worktrees/c0001/repo");
		expect(state.runs["A-devstral"]?.why).toBe(
			"no native tool calls in 7 turns (7 written as text; serving chat template lacks tool calling?)",
		);
	});

	it.each([
		{
			name: "timeout",
			spec: { timeoutMin: 5 },
			signals: {},
			measure: undefined,
			why: "timed out after 5 min",
		},
		{
			name: "tool-call loop",
			spec: { loopRepeats: 25 },
			signals: { findToolCallLoop: async () => ({ count: 25, of: 60, call: "execute_command {}" }) },
			measure: undefined,
			why: "looping: 25 of the last 60 tool calls were execute_command {}",
		},
		{
			name: "cost cap",
			spec: { maxCostUSD: 10 },
			signals: {},
			measure: async () => ({ costUSD: 12.5, tokens: null }),
			why: "cost 12.50 passed the 10 cap",
		},
		{
			name: "never started a turn",
			spec: { timeoutMin: 60 },
			signals: { hasStartedTurn: async () => false },
			measure: undefined,
			why: "codex never started a turn in 10 min (no event log; signed out?)",
		},
	])("ends a running card DNF on $name", async ({ spec: overrides, signals, measure, why }) => {
		const spec = createSpec({
			sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }],
			models: [{ key: "sol", agent: "codex" }],
			...overrides,
		});
		const { harness, run } = createHarness({ spec, paths: createPaths(), signals, measure });
		const state = await run();
		expect(state.runs["A-sol"]).toMatchObject({ verdict: "DNF", why });
		expect(harness.finished).toEqual(["c0001"]);
	});

	it("ends a run whose card was moved to Done by hand, keeping a verdict it wrote", async () => {
		const spec = createSpec({
			sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }],
			models: [{ key: "sol", agent: "codex" }],
		});
		const { harness, run } = createHarness({
			spec,
			paths: createPaths(),
			onPoll: (h) => {
				const card = h.cards[0];
				if (card && card.column === "in_progress") {
					card.column = "trash";
				}
			},
		});
		const state = await run();
		expect(state.runs["A-sol"]).toMatchObject({ verdict: "DNF", why: "card trash" });
		expect(harness.cards[0]?.column).toBe("trash");
	});

	it("waits for a running session even when its verdict is already written", async () => {
		const spec = createSpec({
			sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }],
			models: [{ key: "sol", agent: "codex" }],
		});
		let polls = 0;
		const { harness, run } = createHarness({
			spec,
			paths: createPaths(),
			onPoll: (h) => {
				polls += 1;
				const card = h.cards[0];
				if (!card || card.column === "trash") {
					return;
				}
				h.verdicts.set("/tmp/qa-out/cal/qa-models-t1/A-sol", { kind: "ok", verdict: verdictOf("PASS") });
				if (polls >= 3) {
					h.endTurn(card);
				}
			},
		});
		const state = await run();
		expect(state.runs["A-sol"]?.wallMin).toBe((3 * CALIBRATION_POLL_MS) / 60_000);
		expect(harness.delivered).toEqual([]);
	});

	it("asks the agent's session file when Kanban has no summary for the card", async () => {
		const spec = createSpec({
			sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }],
			models: [{ key: "kimi", agent: "cline", provider: "bedrock", model: "kimi" }],
		});
		let fileRunning = true;
		const isSessionRunning = vi.fn(async () => fileRunning);
		const { harness, run } = createHarness({
			spec,
			paths: createPaths(),
			signals: { isSessionRunning },
			onPoll: (h) => {
				const card = h.cards[0];
				if (!card || card.column === "trash") {
					return;
				}
				// Review with no summary: only the session file knows it still runs (B-kimi, 10/05).
				card.column = "review";
				card.session = null;
				if (h.now() > T0 + 3 * CALIBRATION_POLL_MS) {
					fileRunning = false;
					h.verdicts.set("/tmp/qa-out/cal/qa-models-t1/A-kimi", { kind: "ok", verdict: verdictOf("PASS") });
				}
			},
		});
		const state = await run();
		expect(isSessionRunning).toHaveBeenCalledWith("cline", "/worktrees/c0001/repo");
		expect(harness.delivered).toEqual([]);
		expect(state.runs["A-kimi"]?.verdict).toBe("PASS");
	});

	it("doesn't start a run on a signed-out agent, or one whose dev card has no prompt", async () => {
		const spec = createSpec({
			sets: [
				{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" },
				{ id: "B", ref: "r2", base: "b2", fromCard: "missing" },
			],
			models: [
				{ key: "mai", agent: "copilot", model: "mai-flash" },
				{ key: "sol", agent: "codex" },
			],
		});
		const { harness, run } = createHarness({
			spec,
			paths: createPaths(),
			signals: { isSignedIn: async (agentId) => (agentId === "copilot" ? false : null) },
			onPoll: (h) => {
				for (const card of h.cards) {
					if (card.column === "in_progress") {
						h.endTurn(card, { kind: "ok", verdict: verdictOf("PASS") });
					}
				}
			},
		});
		const state = await run();
		expect(harness.cards.map((card) => card.input.title)).toEqual(["QA-CAL A sol: f80db"]);
		expect(state.runs["A-mai"]).toMatchObject({
			verdict: "DNF",
			why: "copilot is signed out (no login in its config or env); sign it in, then rerun",
		});
		expect(state.runs["B-sol"]).toMatchObject({ verdict: "DNF", why: "could not start: no prompt for card missing" });
		expect(state.runs["A-mai"]?.id).toBeUndefined();
		expect(state.runs["A-mai"]?.signedOut).toBe(true);
	});

	it("retries a run that was not started because its agent was signed out, on a rerun", async () => {
		const spec = createSpec({
			sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }],
			models: [
				{ key: "mai", agent: "copilot", model: "mai-flash" },
				{ key: "sol", agent: "codex" },
			],
		});
		const paths = createPaths();
		await writeCalibrationState(paths.state, {
			version: 1,
			finishedAt: "2026-10-07T09:00:00.000Z",
			runs: {
				"A-mai": {
					done: "2026-10-07T09:00:00.000Z",
					verdict: "DNF",
					why: "copilot is signed out (no login in its config or env); sign it in, then rerun",
					signedOut: true,
				},
				"A-sol": { done: "2026-10-07T09:00:00.000Z", verdict: "DNF", why: "could not start: boom" },
			},
		});
		const { harness, run } = createHarness({
			spec,
			paths,
			onPoll: (h) => {
				for (const card of h.cards) {
					if (card.column === "in_progress") {
						h.endTurn(card, { kind: "ok", verdict: verdictOf("PASS") });
					}
				}
			},
		});
		const state = await run();
		expect(harness.cards.map((card) => card.input.title)).toEqual(["QA-CAL A mai: f80db"]);
		expect(state.runs["A-mai"]).toMatchObject({ verdict: "PASS", id: "c0001" });
		expect(state.runs["A-mai"]?.signedOut).toBeUndefined();
		expect(state.runs["A-sol"]).toMatchObject({ verdict: "DNF", why: "could not start: boom" });
	});

	it("still ends runs at their timeout while the board can't be read, one poll apart", async () => {
		const spec = createSpec({ sets: [{ id: "A", ref: "r1", base: "b1", fromCard: "f80db" }], timeoutMin: 30 });
		const { harness, run } = createHarness({ spec, paths: createPaths(), boardDown: () => true });
		const state = await run();
		const reason = "timed out after 30 min (board unreadable)";
		expect(state.runs["A-sol"]).toMatchObject({ verdict: "DNF", why: reason });
		expect(state.runs["A-haiku"]).toMatchObject({ verdict: "DNF", why: reason });
		expect(harness.finished).toEqual(["c0001", "c0002"]);
		expect(state.finishedAt).not.toBeNull();
		// Polls stay CALIBRATION_POLL_MS apart: the run ends on the first poll past the timeout.
		const failures = harness.log.filter((line) => line.startsWith("reading the board failed: connect ECONNREFUSED"));
		expect(failures).toHaveLength((30 * 60_000) / CALIBRATION_POLL_MS + 1);
		expect(harness.now() - T0).toBe(30 * 60_000 + CALIBRATION_POLL_MS);
	});
});
