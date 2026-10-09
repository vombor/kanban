import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { getVettedRegistry } from "../../../src/models/vetted-registry";
import { buildVetProposal, formatVetReport } from "../../../src/models/vetting/vet-report";
import {
	DEFAULT_VET_LIMITS,
	PROVIDER_TIMEOUT_RETRIES,
	runVet,
	TOOL_LOOP_RULE,
	type VetRunnerDeps,
} from "../../../src/models/vetting/vet-runner";
import {
	checkVetTask,
	createVetTask,
	readTextIfExists,
	type VetCheckDeps,
} from "../../../src/models/vetting/vet-tasks";
import { createTempDir } from "../../utilities/temp-dir";

const REPO = "/tmp/kanban-vet-test/repo";
const COMBINATION = { agentId: "cline" as const, provider: "lemonade", model: "GLM-4.7-Flash-GGUF" };

type FakeAgent = (fake: FakeRun, at: number) => void;

interface FakeRun {
	files: Map<string, string>;
	changed: string[];
	commits: number;
	session: RuntimeTaskSessionSummary | null;
	column: string;
	cost: number;
	textualToolCalls: boolean;
	imageRejection: boolean;
	startedTurn: boolean | null;
}

function summary(state: RuntimeTaskSessionSummary["state"], at: number): RuntimeTaskSessionSummary {
	return {
		taskId: "v0001",
		state,
		agentId: "cline",
		workspacePath: "/worktrees/v0001",
		pid: 42,
		startedAt: 0,
		updatedAt: at,
		stateChangedAt: at,
		lastOutputAt: at,
		reviewReason: state === "awaiting_review" ? "hook" : null,
		exitCode: null,
		lastHookAt: at,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	} as RuntimeTaskSessionSummary;
}

/** A dev agent that does the task right after its start and ends its turn. */
const goodDevAgent: FakeAgent = (fake, at) => {
	if (at === 10_000) {
		const secret = /codename is (\S+)\./u.exec(fake.files.get("NOTES.md") ?? "")?.[1] ?? "";
		fake.files.set("RESULT.md", `codename: ${secret}\ntests: ℹ pass 3\n`);
		fake.changed = ["src/slugify.js", "RESULT.md"];
		fake.commits = 1;
		fake.session = summary("running", at);
	}
	if (at === 20_000) {
		fake.column = "review";
		fake.session = summary("awaiting_review", at);
	}
};

function createHarness(agent: FakeAgent, options: { signedIn?: boolean | null; secret?: string } = {}) {
	const task = createVetTask("dev", options.secret ?? "abcd");
	const fake: FakeRun = {
		files: new Map(task.commits.flatMap((commit) => commit.files.map((file) => [file.path, file.content]))),
		changed: [],
		commits: 0,
		session: null,
		column: "backlog",
		cost: 0.01,
		textualToolCalls: false,
		imageRejection: false,
		startedTurn: true,
	};
	let now = 0;
	const calls: string[] = [];
	const checks: VetCheckDeps = {
		readText: async (path) => fake.files.get(path.slice(REPO.length + 1)) ?? null,
		runTests: async () => ({ ok: fake.changed.includes("src/slugify.js"), output: "# pass 3" }),
		listChangedFiles: async () => fake.changed,
		countNewCommits: async () => fake.commits,
	};
	const deps: VetRunnerDeps = {
		board: {
			createTask: async (input) => {
				calls.push(`create ${input.agentId} ${JSON.stringify(input.agentSettings)}`);
				return "v0001";
			},
			startTask: async () => {
				calls.push("start");
				fake.column = "in_progress";
				fake.session = summary("running", now);
			},
			discardTask: async (taskId) => {
				calls.push(`discard ${taskId}`);
			},
			deliverInput: async (taskId, text) => {
				calls.push(`deliver ${taskId} ${text.slice(0, 40)}`);
				return { ok: true };
			},
			readTask: async () => ({ columnId: fake.column, session: fake.session }),
		},
		signals: {
			isSignedIn: async () => options.signedIn ?? true,
			hasStartedTurn: async () => fake.startedTurn,
			hasImageRejection: async () => fake.imageRejection,
			countToolUse: async () =>
				fake.textualToolCalls ? { native: 0, textual: 4, turns: 2 } : { native: 6, textual: 0, turns: 3 },
			findToolCallLoop: async () => null,
		},
		probe: async () => null,
		findWorktreePath: async () => "/worktrees/v0001",
		measureCostUSD: async () => fake.cost,
		readLatestWriteAt: async () => null,
		checks,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
			agent(fake, now);
		},
		log: () => {},
	};
	return {
		deps,
		fake,
		calls,
		task,
		input: {
			runId: "r1",
			combination: COMBINATION,
			role: "dev" as const,
			task,
			repoPath: REPO,
			limits: DEFAULT_VET_LIMITS,
		},
	};
}

describe("kanban models vet: the runner", () => {
	it("passes a run that reads, edits, runs the tests, commits and ends its turn; the card is discarded", async () => {
		const { deps, calls, input } = createHarness(goodDevAgent);
		const result = await runVet(input, deps);
		expect(result).toMatchObject({ outcome: "passed", failure: null, turnEnded: true, taskId: "v0001" });
		expect(result.checks.every((check) => check.ok)).toBe(true);
		expect(calls).toEqual([
			'create cline {"providerId":"lemonade","modelId":"GLM-4.7-Flash-GGUF"}',
			"start",
			"discard v0001",
		]);
		const proposal = buildVetProposal(getVettedRegistry(), result, "3.0.69");
		expect(proposal.replaces?.model).toBe("GLM-4.7-Flash-GGUF");
		expect(proposal.entry.roles.dev).toMatchObject({
			status: "vetted",
			cliVersion: "3.0.69",
			evidence: { run: "r1" },
		});
		// Other roles' vettings and the capabilities already recorded stay.
		expect(proposal.entry.roles.plan?.status).toBe("vetted");
		expect(proposal.entry.roles.qa?.status).toBe("provisional");
		expect(proposal.entry.capabilities).toMatchObject({ toolUse: true, turnEnd: true, contextWindow: 131072 });
		expect(formatVetReport(result, proposal, { repoPath: REPO })).toContain("Outcome: **PASSED**");
	});

	it("fails a turn that ends without doing the task, and proposes a rejection with the reason", async () => {
		const { deps, input } = createHarness((fake, at) => {
			if (at === 10_000) {
				fake.column = "review";
				fake.session = summary("awaiting_review", at);
			}
		});
		const result = await runVet(input, deps);
		expect(result.outcome).toBe("failed");
		expect(result.failure).toMatchObject({
			kind: "task",
			detail: expect.stringContaining("file read: no RESULT.md"),
		});
		const proposal = buildVetProposal(getVettedRegistry(), result, null);
		expect(proposal.entry.roles.dev).toMatchObject({ status: "rejected", reason: expect.stringContaining("task:") });
	});

	it("stops at the first failure detector, and always discards the card", async () => {
		const notSignedIn = createHarness(goodDevAgent, { signedIn: false });
		expect(await runVet(notSignedIn.input, notSignedIn.deps)).toMatchObject({
			outcome: "failed",
			failure: { kind: "sign_in" },
			taskId: null,
		});
		expect(notSignedIn.calls).toEqual([]);

		const noTurn = createHarness(() => {});
		noTurn.fake.startedTurn = false;
		expect((await runVet(noTurn.input, noTurn.deps)).failure?.kind).toBe("no_session");
		expect(noTurn.calls.at(-1)).toBe("discard v0001");

		const images = createHarness(() => {});
		images.fake.imageRejection = true;
		expect(await runVet(images.input, images.deps)).toMatchObject({
			failure: { kind: "image_rejection" },
			sawImageRejection: true,
		});

		const textual = createHarness(() => {});
		textual.fake.textualToolCalls = true;
		expect((await runVet(textual.input, textual.deps)).failure?.kind).toBe("text_tool_calls");

		const costly = createHarness(() => {});
		costly.fake.cost = 5;
		expect((await runVet(costly.input, costly.deps)).failure).toMatchObject({
			kind: "cost_cap",
			detail: expect.stringContaining("$5.00"),
		});

		const stalled = createHarness((fake, at) => {
			fake.session = { ...summary("running", 0), stateChangedAt: 0, lastHookAt: 0, updatedAt: at };
		});
		expect((await runVet(stalled.input, stalled.deps)).failure?.kind).toBe("silent_stall");

		const overflow = createHarness(() => {});
		overflow.deps.probe = async () => ({
			failure: { kind: "context_overflow", detail: "prompt is too long" },
			hold: null,
		});
		expect((await runVet(overflow.input, overflow.deps)).failure?.kind).toBe("context_overflow");

		const slow = createHarness((fake, at) => {
			fake.session = summary("running", at);
		});
		expect((await runVet(slow.input, slow.deps)).failure).toMatchObject({ kind: "time_cap" });
		expect(slow.calls.at(-1)).toBe("discard v0001");
	});
});

describe("kanban models vet: harness failures (the first runs, 2026-10-09)", () => {
	it("counts a tool loop only for one call filling 3 of the last 4, not a first call or two", async () => {
		const asked: number[] = [];
		const early = createHarness(goodDevAgent);
		early.deps.signals.findToolCallLoop = async (_agent, _path, last) => {
			asked.push(last);
			return { count: 1, of: 1, call: 'run_commands {"commands":["ls -R"]}' };
		};
		expect((await runVet(early.input, early.deps)).outcome).toBe("passed");
		expect(asked[0]).toBe(TOOL_LOOP_RULE.window);

		const twoOfFour = createHarness(goodDevAgent);
		twoOfFour.deps.signals.findToolCallLoop = async () => ({ count: 2, of: 4, call: "read_files {}" });
		expect((await runVet(twoOfFour.input, twoOfFour.deps)).outcome).toBe("passed");

		const looping = createHarness(goodDevAgent);
		looping.deps.signals.findToolCallLoop = async () => ({ count: 3, of: 4, call: "read_files {}" });
		const result = await runVet(looping.input, looping.deps);
		expect(result.failure).toMatchObject({
			kind: "tool_loop",
			detail: "one tool call filled 3 of the last 4: read_files {}",
		});
		expect(buildVetProposal(getVettedRegistry(), result, null).entry.roles.dev?.status).toBe("rejected");
	});

	it("leaves the silence to the probe where it reads the agent (a model still loading)", async () => {
		const loading = createHarness((fake, at) => {
			fake.session = { ...summary("running", 0), stateChangedAt: 0, lastHookAt: 0, updatedAt: at };
		});
		const holds: string[] = [];
		loading.deps.probe = async () => ({ failure: null, hold: "lemonade is still loading GLM-4.7-Flash-GGUF" });
		loading.deps.log = (line) => holds.push(line);
		// No silent_stall at stallMin: the run goes on to the time cap.
		expect((await runVet(loading.input, loading.deps)).failure?.kind).toBe("time_cap");
		expect(holds.filter((line) => line.includes("not judging silence"))).toEqual([
			"vet r1: not judging silence: lemonade is still loading GLM-4.7-Flash-GGUF",
		]);
	});

	it("retries a local provider's timeout, then reports it as a harness failure and proposes provisional", async () => {
		const { deps, calls, input } = createHarness(() => {});
		let occurrence = 0;
		deps.board.deliverInput = async (taskId, text) => {
			calls.push(`deliver ${taskId} ${text.slice(0, 40)}`);
			occurrence += 1;
			return { ok: true };
		};
		deps.probe = async () => ({
			failure: {
				kind: "provider_timeout",
				detail: "provider timeout while lemonade loads Devstral-Small-2507-GGUF: The operation timed out.",
				harness: true,
				occurrence: `s1:${2 + occurrence * 2}`,
			},
			hold: null,
		});
		const result = await runVet(input, deps);
		expect(calls.filter((call) => call.startsWith("deliver"))).toHaveLength(PROVIDER_TIMEOUT_RETRIES);
		expect(calls.at(-1)).toBe("discard v0001");
		expect(result.failure).toMatchObject({
			kind: "provider_timeout",
			harness: true,
			detail: expect.stringMatching(/^provider timeout while lemonade loads .*\(still after 2 retries\)$/u),
		});
		// A registry without the combination's entry, so no recorded capability carries over.
		const registry = getVettedRegistry();
		const proposal = buildVetProposal(
			{ ...registry, entries: registry.entries.filter((entry) => entry.model !== "GLM-4.7-Flash-GGUF") },
			{ ...result, toolUse: { native: 0, textual: 0, turns: 1 } },
			null,
		);
		expect(proposal.entry.roles.dev).toMatchObject({
			status: "provisional",
			reason: expect.stringContaining("provider_timeout: provider timeout while lemonade loads"),
			evidence: { summary: expect.stringContaining("for a harness or environment reason") },
		});
		// No capability is read off a run the environment cut short.
		expect(proposal.entry.capabilities?.toolUse).toBeUndefined();
		expect(formatVetReport(result, proposal, { repoPath: REPO })).toContain("not the model");
	});

	it("waits for a retry to show up instead of retrying the same error twice", async () => {
		const { deps, calls, input } = createHarness(() => {});
		deps.probe = async () => ({
			failure: {
				kind: "provider_timeout",
				detail: "provider timeout on lemonade: timed out",
				harness: true,
				occurrence: "s1:2",
			},
			hold: null,
		});
		const result = await runVet(input, deps);
		// One retry for the error, then (the same error 2 min later) a second one, then the failure.
		expect(calls.filter((call) => call.startsWith("deliver"))).toHaveLength(2);
		expect(result.finishedAt - result.startedAt).toBeGreaterThanOrEqual(4 * 60_000);
	});
});

describe("kanban models vet: the qa task's checks", () => {
	it("wants a FAIL verdict in the QA format that quotes the review id, and no code change", async () => {
		const { path, cleanup } = createTempDir("kanban-vet-qa-");
		try {
			const task = createVetTask("qa", "1234");
			const deps: VetCheckDeps = {
				readText: readTextIfExists,
				runTests: async () => ({ ok: true, output: "" }),
				listChangedFiles: async () => ["outbox/verdict.json"],
				countNewCommits: async () => 0,
			};
			mkdirSync(join(path, "outbox"), { recursive: true });
			writeFileSync(
				join(path, "outbox", "verdict.json"),
				JSON.stringify({ verdict: "PASS", blocking: [], notes: `review ${task.secret}` }),
			);
			expect((await checkVetTask(task, path, deps)).find((check) => check.name === "right verdict")?.ok).toBe(false);
			writeFileSync(
				join(path, "outbox", "verdict.json"),
				JSON.stringify({
					verdict: "FAIL",
					blocking: ["clamp returns min above max"],
					notes: `review ${task.secret}`,
				}),
			);
			expect((await checkVetTask(task, path, deps)).every((check) => check.ok)).toBe(true);
			expect(task.prompt(path)).toContain(join(path, "outbox", "verdict.json"));
		} finally {
			cleanup();
		}
	});
});
