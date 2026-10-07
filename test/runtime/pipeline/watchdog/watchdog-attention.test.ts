import { describe, expect, it } from "vitest";
import type { PipelineSessionView } from "../../../../src/pipeline/engine";
import {
	isHandedOver,
	planHasOpenSteps,
	readPlanHeldIds,
	readTriageVerdict,
	readUserItemIds,
	renderAttention,
} from "../../../../src/pipeline/watchdog/attention";
import { findPromptWaits } from "../../../../src/pipeline/watchdog/prompt-watch";
import { createCard } from "../../../utilities/workspace-state-store";

const ATTENTION = `# Needs a human decision (2026-10-07T10:00:00.000Z)

- **a0001** (review): escalated 2026-10-07T09:00:00Z (3 FAILs); triage: no triage yet

## Orchestrator: needs the user
- **b0001**: pick a model
- ~~**b0002**: done~~
- waiting on **b0003** and **b0004**
`;

describe("ATTENTION.md", () => {
	it("reads the open user items and ignores struck-through ones", () => {
		expect([...readUserItemIds(ATTENTION)].sort()).toEqual(["b0001", "b0003", "b0004"]);
	});

	it("keeps the orchestrator's section and ignores the timestamp when deciding to rewrite", () => {
		const same = renderAttention(
			ATTENTION,
			["- **a0001** (review): escalated 2026-10-07T09:00:00Z (3 FAILs); triage: no triage yet"],
			new Date("2026-10-07T11:00:00.000Z"),
		);
		expect(same.changed).toBe(false);
		expect(same.text).toContain("## Orchestrator: needs the user\n- **b0001**: pick a model");
		const cleared = renderAttention(ATTENTION, [], new Date("2026-10-07T11:00:00.000Z"));
		expect(cleared.changed).toBe(true);
		expect(cleared.text.startsWith("## Orchestrator: needs the user")).toBe(true);
		expect(renderAttention("", [], new Date()).text).toBe("");
	});

	it("reads plan steps and TRIAGE verdicts", () => {
		const plan = "- [wait: P4-1] c0001 then c0002\n- [user] c0003\n- [x] done c0004\n- [ ] snapshot the QA numbers\n";
		expect([...readPlanHeldIds(plan)].sort()).toEqual(["c0001", "c0002", "c0003"]);
		expect(planHasOpenSteps(plan)).toBe(true);
		expect(planHasOpenSteps("- [user] only the user\n")).toBe(false);
		const qaLog = "## TRIAGE a0001: needs decision (10:00Z)\n- x\n## TRIAGE a0001: fixed (11:00Z)\n";
		expect(readTriageVerdict(qaLog, "a0001")).toBe("fixed");
		expect(readTriageVerdict(qaLog, "a0002")).toBeNull();
	});

	it("an escalation, a stopped card or an idle pipeline already handed to the user doesn't wake the orchestrator", () => {
		const users = new Set(["b0001"]);
		const held = new Set(["c0001"]);
		expect(isHandedOver("- **b0001** (review): escalated 2026-… (x); triage: y", users, held)).toBe(true);
		expect(isHandedOver("- **b0009** (review): escalated 2026-… (x); triage: y", users, held)).toBe(false);
		expect(isHandedOver("- **b0001** (review): stopped 2026-… (x); the kit does not rework it", users, held)).toBe(
			true,
		);
		expect(isHandedOver("- **pipeline idle**: nothing …: b0001, c0001", users, held)).toBe(true);
		expect(isHandedOver("- **pipeline idle**: nothing …: b0001, d0001", users, held)).toBe(false);
	});
});

describe("findPromptWaits", () => {
	const now = Date.parse("2026-10-07T12:00:00.000Z");
	const base = {
		selectedAgentId: "claude" as const,
		now,
		stuckMs: 3 * 60_000,
		hooksOnPromptSubmit: (agentId: string) => agentId === "claude" || agentId === "codex",
		agentLabel: (agentId: string) => (agentId === "claude" ? "Claude Code" : agentId),
	};
	const running = (taskId: string, overrides: Partial<PipelineSessionView> = {}): PipelineSessionView => ({
		taskId,
		agentId: "claude",
		modelId: null,
		state: "running",
		startedAt: now - 10 * 60_000,
		lastHookAt: null,
		workspacePath: `/wt/${taskId}`,
		...overrides,
	});

	it("flags a start that never took its prompt as trust or startup, by the folder's trust", () => {
		const waits = findPromptWaits({
			...base,
			cards: [
				{ column: "in_progress", card: createCard({ id: "a1" }) },
				{ column: "in_progress", card: createCard({ id: "a2" }) },
			],
			sessions: new Map([
				["a1", running("a1")],
				["a2", running("a2")],
			]),
			trusted: (_agent, path) => (path === "/wt/a1" ? false : null),
		});
		expect(waits.map((wait) => [wait.taskId, wait.kind])).toEqual([
			["a1", "trust"],
			["a2", "startup"],
		]);
		expect(waits[0]?.text).toContain(`Claude Code's "trust this folder?" dialog`);
	});

	it("uses the effective agent: a card with no agentId on the selected agent is watched, a Cline session is not", () => {
		const waits = findPromptWaits({
			...base,
			cards: [
				{ column: "in_progress", card: createCard({ id: "a1" }) },
				{ column: "in_progress", card: createCard({ id: "a2", agentId: "claude" }) },
			],
			sessions: new Map([
				["a1", running("a1", { agentId: null })],
				["a2", running("a2", { agentId: "cline" })],
			]),
			trusted: () => true,
		});
		expect(waits.map((wait) => wait.taskId)).toEqual(["a1"]);
	});

	it("flags an unanswered permission request; never a Backlog card or a recent hook", () => {
		const permission = {
			activityText: "Bash(rm -rf node_modules)",
			toolName: "Bash",
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: "Notification",
			notificationType: "permission_prompt",
			source: null,
		};
		const waits = findPromptWaits({
			...base,
			cards: [
				{ column: "review", card: createCard({ id: "a1" }) },
				{ column: "review", card: createCard({ id: "a2" }) },
				{ column: "backlog", card: createCard({ id: "a3" }) },
			],
			sessions: new Map([
				["a1", running("a1", { lastHookAt: now - 5 * 60_000, latestHookActivity: permission })],
				["a2", running("a2", { lastHookAt: now - 60_000, latestHookActivity: permission })],
				["a3", running("a3")],
			]),
			trusted: () => true,
		});
		expect(waits).toEqual([expect.objectContaining({ taskId: "a1", kind: "approval" })]);
		expect(waits[0]?.text).toContain("Bash(rm -rf node_modules)");
	});
});
