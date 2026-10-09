// The rework loop's limits against a stub kit (plan §9): the core caps a kit that always says `rework`, refuses a
// rework that would switch model, and parks escalated cards in Backlog as BLOCKED. No test here reads kits/team.json; one runs team-local's real policy.
import { afterEach, describe, expect, it } from "vitest";
import { createRoutingPolicy, type OnFailAnswer } from "../../../src/kits/policy";
import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";
import type {
	PipelineRunoffGroup,
	PipelineRunoffGroupHandler,
	PipelineRunoffGroups,
} from "../../../src/pipeline/features";
import { handBackTask } from "../../../src/pipeline/handback";
import { REWORK_STARTED_CHECK_MS, readEscalationRecord, readQaflow, readReworks } from "../../../src/pipeline/rework";
import { createReworkHarness, failVerdict, REWORK_T0, type ReworkHarnessOptions } from "../../utilities/rework-stage";
import { PROVISIONAL_ALLOWED } from "../../utilities/routing-vetting";
import { createCard } from "../../utilities/workspace-state-store";

const DEV = createCard({
	id: "d1111",
	title: "Wishlist",
	prompt: "Build the wishlist.\n\nFINAL STEP: print STATUS: DONE",
	agentId: "cline",
	agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
});
const SESSION = { taskId: "d1111", agentId: "cline" as const, modelId: "us.openai.gpt-6.1-sol" };

function kinds(actions: ReturnType<typeof createReworkHarness>["actions"]) {
	return actions.map(
		(action) => `${action.kind}:${"taskId" in action ? action.taskId : "task" in action ? action.task.taskId : ""}`,
	);
}

describe("rework limits", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	const createHarness = (options?: ReworkHarnessOptions) => {
		const harness = createReworkHarness(options);
		harnesses.push(harness);
		return harness;
	};
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	it("sends a FAIL back to the same card once: REWORK section before FINAL STEP, typed into its session", async () => {
		const harness = createHarness();
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });

		await harness.tick({ review: [DEV] }, [SESSION]);
		await harness.tick({ review: [DEV] }, [SESSION]);

		expect(kinds(harness.actions)).toEqual(["updateTask:d1111", "deliverInput:d1111"]);
		const update = harness.actions[0];
		const prompt = update?.kind === "updateTask" ? (update.prompt ?? "") : "";
		expect(prompt.indexOf("REWORK round 2 (QA round 1: FAIL;")).toBeGreaterThan(0);
		expect(prompt.indexOf("REWORK round 2")).toBeLessThan(prompt.indexOf("FINAL STEP"));
		expect(prompt).toContain("- blocker of round 1");
		expect(prompt).toContain(".qa/r1/ in your worktree");
		const delivered = harness.actions[1];
		expect(delivered?.kind === "deliverInput" ? delivered.text : "").toMatch(/^REWORK round 2/u);
		expect(harness.onFailCalls).toHaveLength(1);
		expect(harness.onFailCalls[0]).toMatchObject({
			cause: "fail",
			dev: { agentId: "cline", model: { model: "us.openai.gpt-6.1-sol" } },
			history: { failRounds: [1] },
			limits: { maxFailRounds: 3 },
		});
		const qaflow = readQaflow(await harness.entry("d1111"));
		expect(qaflow.handled).toEqual([`r1|FAIL|${new Date(failVerdict(1).at).toISOString()}`]);
		expect(readReworks(qaflow)).toMatchObject([{ round: 1, next: 2, via: "chat", kind: "fail" }]);
		expect(harness.events).toMatchObject([{ name: "reworkSent", event: { taskId: "d1111", round: 2 } }]);
		expect(harness.readQaLog()).toContain(
			"## Kanban REWORK d1111 round 2: back to cline on bedrock/us.openai.gpt-6.1-sol",
		);
	});

	it("escalates at maxFailRounds whatever the kit says, and a handback with extra rounds reworks that FAIL once", async () => {
		const harness = createHarness();
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1), failVerdict(2), failVerdict(3)] });

		await harness.tick({ review: [DEV] }, [SESSION]);

		// The stub always answers rework; at the cap the core escalates to the orchestrator anyway.
		expect(harness.onFailCalls).toHaveLength(1);
		expect(kinds(harness.actions)).toEqual(["blockTask:d1111"]);
		const escalated = readEscalationRecord(readQaflow(await harness.entry("d1111")));
		expect(escalated).toMatchObject({
			round: 3,
			reason: "3 FAIL rounds (rounds 1, 2, 3)",
			to: "orchestrator",
			cause: "fail",
		});
		expect(harness.readQaLog()).toContain("## ESCALATE d1111: needs human (3 FAIL rounds (rounds 1, 2, 3))");
		expect(harness.readQaLog()).toContain("kanban task handback --task-id d1111");
		expect(harness.events).toMatchObject([{ name: "escalated", event: { to: "orchestrator", round: 3 } }]);

		// Escalated: nothing more while it stays escalated.
		harness.actions.length = 0;
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(harness.actions).toEqual([]);

		await expect(
			handBackTask(harness.store, {
				workspaceId: "foo",
				taskId: "d2222",
				note: "x",
				extraRounds: 1,
				by: "user",
				now: REWORK_T0,
			}),
		).rejects.toThrow('Task "d2222" is not escalated');
		const handback = await handBackTask(harness.store, {
			workspaceId: "foo",
			taskId: "d1111",
			note: "flaky QA, try again",
			extraRounds: 2,
			by: "user",
			now: REWORK_T0 + 60_000,
		});
		expect(handback.qaLogSection).toContain("## HANDBACK d1111: back to the pipeline (+2 FAIL rounds)");
		expect(handback.qaLogSection).toContain("Was escalated 2026-10-07T10:00:00.000Z: 3 FAIL rounds");

		harness.setNow(REWORK_T0 + 2 * 60_000);
		await harness.tick({ review: [DEV] }, [SESSION]);
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(harness.actions)).toEqual(["updateTask:d1111", "deliverInput:d1111"]);
		expect(harness.onFailCalls.at(-1)).toMatchObject({
			history: { failRounds: [1, 2, 3], extraRounds: 2, handbacks: 1 },
		});
		const qaflow = readQaflow(await harness.entry("d1111"));
		expect(qaflow.escalated).toBeUndefined();
		expect(qaflow.handbackActed).toEqual(["2026-10-07T10:01:00.000Z"]);
		const update = harness.actions[0];
		expect(update?.kind === "updateTask" ? update.prompt : "").toContain(
			"after 5 failed QA rounds the card goes to a human",
		);
	});

	it("refuses a rework that would switch model, and one with no session on a card that doesn't pin its model", async () => {
		const switched = createHarness();
		await switched.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await switched.tick({ review: [DEV] }, [{ ...SESSION, modelId: "us.moonshot.kimi-k3" }]);
		expect(kinds(switched.actions)).toEqual(["blockTask:d1111"]);
		expect(readEscalationRecord(readQaflow(await switched.entry("d1111")))).toMatchObject({
			cause: "rework_impossible",
			reason:
				"rework impossible without switching model: the work was done on us.moonshot.kimi-k3 but the card is set to us.openai.gpt-6.1-sol",
		});

		// No session to type into: a card without its own model would restart on the agent's default → escalate.
		const unpinned = createHarness({
			actionResult: (action) => (action.kind === "deliverInput" ? { ok: false, error: "no session" } : { ok: true }),
		});
		const card = createCard({ id: "d1111", prompt: "Build it" });
		await unpinned.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await unpinned.tick({ review: [card] }, [{ taskId: "d1111", agentId: "claude", modelId: "claude-opus-5-5" }]);
		expect(kinds(unpinned.actions)).toEqual(["updateTask:d1111", "deliverInput:d1111", "blockTask:d1111"]);
		expect(readEscalationRecord(readQaflow(await unpinned.entry("d1111")))?.reason).toContain(
			"the card does not pin its model",
		);

		// The same with a pinned model: a fresh session from the card prompt, on the effective agent.
		const pinned = createHarness({
			actionResult: (action) => (action.kind === "deliverInput" ? { ok: false, error: "no session" } : { ok: true }),
		});
		await pinned.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await pinned.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(pinned.actions)).toEqual(["updateTask:d1111", "deliverInput:d1111", "resumeTask:d1111"]);
		expect(pinned.actions[2]).toMatchObject({ agentId: "cline" });
		expect(readReworks(readQaflow(await pinned.entry("d1111")))).toMatchObject([{ via: "task start" }]);
	});

	it("escalation to a model keeps the work as a preserve tag and hands the task to a sibling; requireApproval leaves it in Backlog", async () => {
		const target = {
			agentId: "cline" as const,
			model: { provider: "bedrock", model: "us.anthropic.claude-sonnet-5-5" },
		};
		const approval = createHarness({
			onFail: () => ({ action: "escalate", to: target, requireApproval: true, reason: "tier 2" }),
		});
		await approval.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await approval.tick({ review: [DEV] }, [SESSION]);

		expect(approval.preservedTags).toEqual(["preserve/d1111-gpt-6.1-sol"]);
		expect(kinds(approval.actions)).toEqual(["createTask:s0001", "blockTask:d1111"]);
		const created = approval.actions[0];
		expect(created).toMatchObject({
			kind: "createTask",
			task: {
				title: "Wishlist [claude-sonnet-5-5]",
				role: "dev",
				agentId: "cline",
				agentSettings: { providerId: "bedrock", modelId: "us.anthropic.claude-sonnet-5-5" },
				baseRef: "main",
			},
		});
		const prompt = created?.kind === "createTask" ? created.task.prompt : "";
		expect(prompt).toContain("ESCALATED FROM d1111 (tier 2;");
		expect(prompt).toContain("git tag preserve/d1111-gpt-6.1-sol");
		expect(prompt.indexOf("ESCALATED FROM")).toBeLessThan(prompt.indexOf("FINAL STEP"));
		expect(readEscalationRecord(readQaflow(await approval.entry("d1111")))).toMatchObject({
			to: target,
			requireApproval: true,
			sibling: { taskId: "s0001", tag: "preserve/d1111-gpt-6.1-sol", started: false },
		});
		expect((await approval.entry("s0001"))?.sibling).toMatchObject({ of: "d1111", kind: "escalation" });

		const started = createHarness({
			onFail: () => ({ action: "escalate", to: target, requireApproval: false, reason: "tier 2" }),
		});
		await started.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await started.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(started.actions)).toEqual(["createTask:s0001", "startTask:s0001", "blockTask:d1111"]);

		// A tag that can't be written: nothing is handed over, the card goes to the orchestrator instead.
		const untagged = createHarness({
			onFail: () => ({ action: "escalate", to: target, requireApproval: false, reason: "tier 2" }),
			preserveWork: async () => {
				throw new Error("no worktree");
			},
		});
		await untagged.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await untagged.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(untagged.actions)).toEqual(["blockTask:d1111"]);
		expect(readEscalationRecord(readQaflow(await untagged.entry("d1111")))).toMatchObject({ to: "orchestrator" });
	});

	it("never takes a task over onto the card's own model, nor a second time in the same chain (#8)", async () => {
		const kimi = { agentId: "codex" as const, model: { provider: "bedrock", model: "us.moonshotai.kimi-k3" } };
		const escalateToKimi = (): OnFailAnswer => ({
			action: "escalate",
			to: kimi,
			requireApproval: false,
			reason: "3 FAIL rounds",
		});
		// The sibling on kimi fails its rounds: escalate.to is kimi again, so the orchestrator gets it.
		const sameModel = createHarness({ onFail: escalateToKimi });
		const sibling = {
			...DEV,
			id: "s2222",
			agentId: "codex" as const,
			agentSettings: { providerId: "bedrock", modelId: "us.moonshotai.kimi-k3" },
		};
		await sameModel.seed("s2222", { qaVerdicts: [failVerdict(1, { snapshot: "snap-s2222" })] });
		await sameModel.tick({ review: [sibling] }, [
			{ taskId: "s2222", agentId: "codex", modelId: "us.moonshotai.kimi-k3" },
		]);
		expect(kinds(sameModel.actions)).toEqual(["blockTask:s2222"]);
		expect(sameModel.preservedTags).toEqual([]);
		expect(readEscalationRecord(readQaflow(await sameModel.entry("s2222")))).toMatchObject({
			to: "orchestrator",
			reason: expect.stringContaining("it already runs on bedrock/us.moonshotai.kimi-k3"),
		});

		// A sibling that took the task over hands it to nobody else, even on another model.
		const chain = createHarness({ onFail: escalateToKimi });
		await chain.seed("d1111", {
			qaVerdicts: [failVerdict(1)],
			sibling: { of: "a0000", kind: "escalation", at: new Date(REWORK_T0 - 60_000).toISOString() },
		});
		await chain.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(chain.actions)).toEqual(["blockTask:d1111"]);
		expect(readEscalationRecord(readQaflow(await chain.entry("d1111")))).toMatchObject({
			to: "orchestrator",
			reason: expect.stringContaining("it already took the task over from a0000"),
		});
	});

	it("team-local: after its FAIL rounds a card goes to the fallback local model once, then to the orchestrator", async () => {
		const kit = getBuiltInKits().get("team-local");
		const resolved = kit
			? resolveKitLayers(getDefaultKit(), kit, {})
			: { ok: false as const, error: "no team-local kit" };
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		const policy = createRoutingPolicy(resolved.kit, PROVISIONAL_ALLOWED);
		const glm = { providerId: "lemonade", modelId: "GLM-4.7-Flash-GGUF" };
		const dev = { ...DEV, agentSettings: glm };
		const fails = [failVerdict(1), failVerdict(2), failVerdict(3)];

		const first = createHarness({ onFail: (input) => policy.onFail(input) });
		await first.seed("d1111", { qaVerdicts: fails });
		await first.tick({ review: [dev] }, [{ taskId: "d1111", agentId: "cline", modelId: "GLM-4.7-Flash-GGUF" }]);
		expect(kinds(first.actions)).toEqual(["createTask:s0001", "startTask:s0001", "blockTask:d1111"]);
		expect(first.actions[0]).toMatchObject({
			task: { agentId: "cline", agentSettings: { providerId: "lemonade", modelId: "Qwen3.6-35B-A3B-MTP-GGUF" } },
		});

		// The fallback sibling fails its rounds too: no second takeover, the orchestrator gets it.
		const fallback = createHarness({ onFail: (input) => policy.onFail(input) });
		const sibling = {
			...DEV,
			id: "s0001",
			agentSettings: { providerId: "lemonade", modelId: "Qwen3.6-35B-A3B-MTP-GGUF" },
		};
		await fallback.seed("s0001", {
			qaVerdicts: fails.map((verdict) => ({ ...verdict, snapshot: "snap-s0001" })),
			sibling: { of: "d1111", kind: "escalation", at: new Date(REWORK_T0 - 60_000).toISOString() },
		});
		await fallback.tick({ review: [sibling] }, [
			{ taskId: "s0001", agentId: "cline", modelId: "Qwen3.6-35B-A3B-MTP-GGUF" },
		]);
		expect(kinds(fallback.actions)).toEqual(["blockTask:s0001"]);
		expect(readEscalationRecord(readQaflow(await fallback.entry("s0001")))).toMatchObject({ to: "orchestrator" });
	});

	it("carries out recovery's outage takeover request: a sibling on the target, the card blocked, in any column (#8)", async () => {
		const kimi = { agentId: "codex" as const, model: { provider: "bedrock", model: "us.moonshotai.kimi-k3" } };
		const harness = createHarness();
		const takeover = {
			at: new Date(REWORK_T0).toISOString(),
			cause: "outage",
			reason: "provider outage on us.openai.gpt-6.1-sol for 360 min",
			to: kimi,
			requireApproval: false,
			details: ["last error: 503"],
		};
		await harness.seed("d1111", { qaflow: { takeover } });
		await harness.tick({ in_progress: [DEV] }, [SESSION]);

		expect(harness.preservedTags).toEqual(["preserve/d1111-gpt-6.1-sol"]);
		expect(kinds(harness.actions)).toEqual(["createTask:s0001", "startTask:s0001", "blockTask:d1111"]);
		expect(harness.actions[0]).toMatchObject({
			task: { agentId: "codex", agentSettings: { providerId: "bedrock", modelId: "us.moonshotai.kimi-k3" } },
		});
		const qaflow = readQaflow(await harness.entry("d1111"));
		expect(qaflow.takeover).toBeUndefined();
		expect(readEscalationRecord(qaflow)).toMatchObject({
			cause: "outage",
			to: kimi,
			sibling: { taskId: "s0001", started: true },
		});
		expect(harness.onFailCalls).toEqual([]);
		expect(harness.readQaLog()).toContain("last error: 503");

		// Acted on once: the next tick finds no request.
		await harness.tick({ backlog: [DEV] }, [SESSION]);
		expect(harness.actions).toHaveLength(3);
	});

	it("an escalation sibling of an imported card carries its issue, so its land still closes the issue", async () => {
		const issue = {
			provider: "github" as const,
			repo: "vombor/kanban",
			number: 12,
			url: "https://github.com/vombor/kanban/issues/12",
			updatedAt: "2026-10-07T00:00:00Z",
		};
		const harness = createHarness({
			onFail: () => ({
				action: "escalate",
				to: { agentId: "cline", model: { provider: "bedrock", model: "us.anthropic.claude-sonnet-5-5" } },
				requireApproval: true,
				reason: "tier 2",
			}),
		});
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [{ ...DEV, issue }] }, [SESSION]);
		expect(harness.actions[0]).toMatchObject({ kind: "createTask", task: { taskId: "s0001", issue } });
	});

	it("escalates a runoff when no feature holds the siblings' PASSes (a kit without runoffs), creating no card", async () => {
		const harness = createHarness({
			onFail: () => ({
				action: "runoff",
				models: [{ agentId: "cline", provider: "bedrock", model: "us.moonshot.kimi-k3" }],
			}),
		});
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);

		expect(kinds(harness.actions)).toEqual(["blockTask:d1111"]);
		expect(readEscalationRecord(readQaflow(await harness.entry("d1111")))).toMatchObject({
			to: "orchestrator",
			reason: expect.stringContaining(
				"the kit answered runoff (us.moonshot.kimi-k3), but the workspace's kit doesn't run the \"runoffs\" feature",
			),
		});
	});

	const runoffAnswer = (): OnFailAnswer => ({
		action: "runoff",
		models: [
			{ agentId: "cline", provider: "bedrock", model: "us.moonshotai.kimi-k3" },
			{ agentId: "codex", provider: null, model: "gpt-6.1" },
		],
	});

	function createGroups(options: { racing?: string | null; failRecord?: boolean } = {}) {
		const recorded: PipelineRunoffGroup[] = [];
		const handler: PipelineRunoffGroupHandler = {
			groupOf: async () => options.racing ?? null,
			record: async (group) => {
				if (options.failRecord) {
					throw new Error("disk full");
				}
				recorded.push(structuredClone(group));
			},
		};
		return { recorded, groups: { forWorkspace: () => handler } satisfies PipelineRunoffGroups };
	}

	it("a runoff answer records the group first, then races sibling cards (never board-linked) and reworks the failed card", async () => {
		const { recorded, groups } = createGroups();
		const harness = createHarness({ onFail: runoffAnswer, runoffGroups: groups });
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);

		expect(recorded).toEqual([
			{
				name: "d1111-r1",
				from: "d1111",
				round: 1,
				baseRef: "main",
				cards: [
					{ taskId: "d1111", agentId: "cline", model: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" } },
					{ taskId: "s0001", agentId: "cline", model: { provider: "bedrock", model: "us.moonshotai.kimi-k3" } },
					{ taskId: "s0002", agentId: "codex", model: { provider: null, model: "gpt-6.1" } },
				],
			},
		]);
		expect(kinds(harness.actions)).toEqual([
			"createTask:s0001",
			"startTask:s0001",
			"createTask:s0002",
			"startTask:s0002",
			"updateTask:d1111",
			"deliverInput:d1111",
		]);
		const created = harness.actions[0];
		expect(created).toMatchObject({
			kind: "createTask",
			task: {
				title: "Wishlist [runoff d1111-r1: kimi-k3]",
				role: "dev",
				agentId: "cline",
				agentSettings: { providerId: "bedrock", modelId: "us.moonshotai.kimi-k3" },
			},
		});
		const prompt = created?.kind === "createTask" ? created.task.prompt : "";
		expect(prompt).toContain("RUNOFF d1111-r1 (with card d1111, after its QA round 1;");
		expect(prompt).toContain("- blocker of round 1");
		expect(prompt.indexOf("RUNOFF d1111-r1")).toBeLessThan(prompt.indexOf("FINAL STEP"));
		expect((await harness.entry("s0002"))?.sibling).toMatchObject({
			of: "d1111",
			kind: "runoff",
			runoff: "d1111-r1",
		});
		expect(readEscalationRecord(readQaflow(await harness.entry("d1111")))).toBeNull();
		expect(harness.readQaLog()).toContain(
			"## RUNOFF d1111-r1 STARTED: d1111 (cline on bedrock/us.openai.gpt-6.1-sol) races s0001",
		);
	});

	it("a card that already races is reworked instead of starting a nested runoff", async () => {
		const { recorded, groups } = createGroups({ racing: "d0000-r1" });
		const harness = createHarness({ onFail: runoffAnswer, runoffGroups: groups });
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);

		expect(recorded).toEqual([]);
		expect(kinds(harness.actions)).toEqual(["updateTask:d1111", "deliverInput:d1111"]);
	});

	it("creates no sibling when the group can't be recorded, and drops the ones that failed from it", async () => {
		const failing = createGroups({ failRecord: true });
		const unrecorded = createHarness({ onFail: runoffAnswer, runoffGroups: failing.groups });
		await unrecorded.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await unrecorded.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(unrecorded.actions)).toEqual(["blockTask:d1111"]);
		expect(readEscalationRecord(readQaflow(await unrecorded.entry("d1111")))?.reason).toContain(
			"recording runoff d1111-r1 failed (disk full)",
		);

		const partial = createGroups();
		const harness = createHarness({
			onFail: runoffAnswer,
			runoffGroups: partial.groups,
			actionResult: (action) =>
				action.kind === "createTask" && action.task.taskId === "s0002"
					? { ok: false, error: "board busy" }
					: { ok: true },
		});
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(partial.recorded.map((group) => group.cards.map((card) => card.taskId))).toEqual([
			["d1111", "s0001", "s0002"],
			["d1111", "s0001"],
		]);
		expect(kinds(harness.actions)).toContain("updateTask:d1111");
	});

	const handBack = async (harness: ReturnType<typeof createReworkHarness>, now: number, extraRounds = 1) =>
		await handBackTask(harness.store, {
			workspaceId: "foo",
			taskId: "d1111",
			note: "go",
			extraRounds,
			by: "user",
			now,
		});

	it("a handback after a never-started rework sends it again instead of escalating it again", async () => {
		const harness = createHarness();
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);
		harness.setNow(REWORK_T0 + REWORK_STARTED_CHECK_MS);
		await harness.tick({ review: [DEV] }, [SESSION]);
		harness.setNow(REWORK_T0 + 2 * REWORK_STARTED_CHECK_MS);
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(readEscalationRecord(readQaflow(await harness.entry("d1111")))?.cause).toBe("never_started");

		await handBack(harness, REWORK_T0 + 5 * 60_000);
		expect(readReworks(readQaflow(await harness.entry("d1111")))[0]).toMatchObject({ closedBy: "handback" });
		harness.actions.length = 0;
		harness.setNow(REWORK_T0 + 6 * 60_000);
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(harness.actions)).toEqual(["updateTask:d1111", "deliverInput:d1111"]);
		harness.setNow(REWORK_T0 + 7 * 60_000);
		await harness.tick({ in_progress: [DEV] }, [{ ...SESSION, state: "running" }]);
		expect(kinds(harness.actions)).toEqual(["updateTask:d1111", "deliverInput:d1111"]);
		expect(readEscalationRecord(readQaflow(await harness.entry("d1111")))).toBeNull();
	});

	it("a handback after rework_impossible acts once more on the FAIL (the card was fixed meanwhile)", async () => {
		const harness = createHarness();
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [{ ...SESSION, modelId: "us.moonshot.kimi-k3" }]);
		expect(readEscalationRecord(readQaflow(await harness.entry("d1111")))?.cause).toBe("rework_impossible");

		await handBack(harness, REWORK_T0 + 60_000);
		harness.actions.length = 0;
		harness.setNow(REWORK_T0 + 2 * 60_000);
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(harness.actions)).toEqual(["updateTask:d1111", "deliverInput:d1111"]);
	});

	it("a handback after the not-started path (no session, unpinned model) doesn't re-escalate the old rework", async () => {
		let sessionGone = true;
		const harness = createHarness({
			actionResult: (action) =>
				action.kind === "deliverInput" && sessionGone ? { ok: false, error: "no session" } : { ok: true },
		});
		const card = createCard({ id: "d1111", prompt: "Build it" });
		const session = { taskId: "d1111", agentId: "claude" as const, modelId: "claude-opus-5-5" };
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [card] }, [session]);
		expect(readReworks(readQaflow(await harness.entry("d1111")))[0]).toMatchObject({ via: "not started" });
		expect(readEscalationRecord(readQaflow(await harness.entry("d1111")))?.cause).toBe("rework_impossible");

		await handBack(harness, REWORK_T0 + 5 * 60_000);
		sessionGone = false;
		harness.actions.length = 0;
		harness.setNow(REWORK_T0 + 10 * 60_000);
		await harness.tick({ review: [card] }, [session]);
		expect(kinds(harness.actions)).toEqual(["updateTask:d1111", "deliverInput:d1111"]);
		expect(readEscalationRecord(readQaflow(await harness.entry("d1111")))).toBeNull();
	});

	it("a STALLED from the QA agent's own errors goes to the orchestrator, never to the kit's takeover (issue #12)", async () => {
		const harness = createHarness({
			onFail: () => ({
				action: "escalate",
				to: { agentId: "codex", model: { provider: "bedrock", model: "us.moonshot.kimi-k3" } },
				requireApproval: false,
				reason: "QA stalled: take it over",
			}),
		});
		await harness.seed("d1111", {
			qaVerdicts: [
				failVerdict(1, {
					verdict: "STALLED",
					qaAgentError: "image over the model's size limits: At least one of the image dimensions exceed …",
				}),
			],
		});
		await harness.tick({ review: [DEV] }, [SESSION]);

		expect(harness.onFailCalls).toEqual([]);
		expect(kinds(harness.actions)).toEqual(["blockTask:d1111"]);
		const escalated = readEscalationRecord(readQaflow(await harness.entry("d1111")));
		expect(escalated).toMatchObject({ to: "orchestrator", cause: "qa_agent_error" });
		expect(escalated?.reason).toContain("the QA agent's own runs failed");
		expect(escalated?.sibling).toBeUndefined();

		const result = await handBack(harness, REWORK_T0 + 60_000, 0);
		expect(result.reworks).toBe(false);
		expect(result.qaLogSection).toContain("the QA gate gives the same snapshot a new QA card");
	});

	it("a handback after a STALLED escalation says the pipeline won't rework it, and doesn't", async () => {
		const harness = createHarness({
			onFail: (input) =>
				input.cause === "stalled"
					? { action: "escalate", to: "orchestrator", requireApproval: false, reason: "QA stalled" }
					: { action: "rework", clearContext: "auto" },
		});
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1, { verdict: "STALLED" })] });
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(readEscalationRecord(readQaflow(await harness.entry("d1111")))?.cause).toBe("stalled");

		const result = await handBack(harness, REWORK_T0 + 60_000, 2);
		expect(result.reworks).toBe(false);
		expect(result.qaLogSection).toContain("STALLED QA round, which the pipeline does not rework");
		harness.actions.length = 0;
		harness.setNow(REWORK_T0 + 2 * 60_000);
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(harness.actions).toEqual([]);
	});

	it("sends a rework again that a stopped worker left pending, unless the card ran meanwhile", async () => {
		const harness = createHarness();
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		// A sent rework, set back to the state a worker that died right after recording it leaves.
		const sent = createHarness();
		await sent.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await sent.tick({ review: [DEV] }, [SESSION]);
		const qaflow = readQaflow(await sent.entry("d1111"));
		const pending = {
			...qaflow,
			reworks: readReworks(qaflow).map((rework) => ({ ...rework, via: "pending", clearedContext: false })),
		};
		expect(readReworks(pending)[0]?.trigger).toMatchObject({ cause: "fail", round: 1 });

		await harness.seed("d1111", { qaflow: pending });
		harness.setNow(REWORK_T0 + 60_000);
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(harness.actions).toEqual([]);
		harness.setNow(REWORK_T0 + REWORK_STARTED_CHECK_MS);
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(harness.actions)).toEqual(["updateTask:d1111", "deliverInput:d1111"]);
		const reworks = readReworks(readQaflow(await harness.entry("d1111")));
		expect(reworks.map((rework) => [rework.via, rework.closedBy ?? null])).toEqual([
			["pending", "resent"],
			["chat", null],
		]);
		const update = harness.actions[0];
		expect(update?.kind === "updateTask" ? update.prompt : "").toContain("This is rework 1 of at most 2");

		const ran = createHarness();
		await ran.seed("d1111", { qaVerdicts: [failVerdict(1)], qaflow: pending });
		ran.setNow(REWORK_T0 + REWORK_STARTED_CHECK_MS);
		await ran.tick({ in_progress: [DEV] }, [{ ...SESSION, state: "running" }]);
		expect(ran.actions).toEqual([]);
		expect(readReworks(readQaflow(await ran.entry("d1111")))[0]).toMatchObject({ via: "chat" });
	});

	it("stop leaves the card in Review with qaflow.stopped, and only dev cards in Review with fresh verdicts count", async () => {
		const harness = createHarness({ onFail: () => ({ action: "stop", reason: "the kit does not rework" }) });
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.seed("old11", {
			qaVerdicts: [failVerdict(1, { snapshot: "snap-old11", at: REWORK_T0 - 2 * 60 * 60_000 })],
		});
		await harness.seed("qa111", { qaVerdicts: [failVerdict(1, { snapshot: "snap-qa111" })] });
		await harness.seed("held1", {
			qaVerdicts: [failVerdict(1, { snapshot: "snap-held1" })],
			hold: { group: "g", at: "x", round: 1 },
		});
		await harness.seed("prog1", { qaVerdicts: [failVerdict(1, { snapshot: "snap-prog1" })] });

		await harness.tick(
			{
				review: [
					DEV,
					createCard({ id: "old11" }),
					createCard({ id: "qa111", role: "qa" }),
					createCard({ id: "held1" }),
				],
				in_progress: [createCard({ id: "prog1" })],
			},
			[SESSION],
		);

		expect(harness.actions).toEqual([]);
		expect(harness.onFailCalls.map((call) => call.dev.card.id)).toEqual(["d1111"]);
		expect(readQaflow(await harness.entry("d1111")).stopped).toMatchObject({
			reason: "the kit does not rework",
			cause: "fail",
			round: 1,
		});
		expect(harness.readQaLog()).toContain("## STOPPED d1111: the kit does not rework");
	});
});
