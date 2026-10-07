// Regression test for the 2026-10-06 incident (plan §4.0, §9). On kanban-2uge every card was meant to run on
// Kanban's selected agent (Claude) and be landed by the orchestrator. The legacy kit skipped only cards whose
// literal agentId was "claude", so unpinned cards counted as Cline dev cards: P0-2 was QA'd and landed, P0-3 and
// P0-2b were escalated. And a project entry inherited the top-level routing toggles, so a new board got foo's
// routing without asking for it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getWorkspacePipelineSettings, parsePipelineConfig } from "../../../src/config/pipeline-config";
import { runtimeAgentIdEnumSchema } from "../../../src/core/api-contract";
import type { QaPolicyAnswer, RoutingPolicy } from "../../../src/kits/policy";
import { evaluatePipelineWorkspace } from "../../../src/pipeline/engine";
import { createAutoReviewReconciler } from "../../../src/server/auto-review-reconciler";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createPipelineWorkerHarness, createSnapshot } from "../../utilities/pipeline-worker";
import { createBoard, createCard, createWorkspaceStateStore } from "../../utilities/workspace-state-store";

// The kanban-2uge board: Claude selected, three cards in Review with work.
function createIncidentBoard() {
	return createBoard({
		review: [
			createCard({ id: "unpinned" }),
			createCard({ id: "pinned-claude", agentId: "claude" }),
			createCard({ id: "pinned-cline", agentId: "cline" }),
		],
	});
}

const QA_STUB_ANSWER: QaPolicyAnswer = {
	kind: "qa",
	agentId: "codex",
	model: null,
	route: null,
	promptParts: {
		rules: [],
		blurb: "",
		notes: { screenshotFallback: "", knownBaseIssues: "", dbSetup: "" },
		serversScript: null,
	},
};

function createStubPolicy() {
	return {
		devAssignment: vi.fn<RoutingPolicy["devAssignment"]>(() => null),
		qaPolicy: vi.fn<RoutingPolicy["qaPolicy"]>(() => QA_STUB_ANSWER),
		onFail: vi.fn<RoutingPolicy["onFail"]>(() => ({ action: "stop", reason: "stub" })),
		onPass: vi.fn<RoutingPolicy["onPass"]>(() => ({ action: "land" })),
	} satisfies RoutingPolicy;
}

async function askStubPolicy(input: {
	selectedAgentId: "claude" | "cline";
	sessions?: Array<{ taskId: string; agentId: "claude" | "cline" }>;
}) {
	const policy = createStubPolicy();
	const parsed = parsePipelineConfig({ workspaces: { "kanban-2uge": { landing: { mode: "qa" } } } });
	await evaluatePipelineWorkspace({
		snapshot: createSnapshot({
			workspaceId: "kanban-2uge",
			board: createIncidentBoard(),
			selectedAgentId: input.selectedAgentId,
			sessions: input.sessions,
		}),
		settings: getWorkspacePipelineSettings(parsed.config, "kanban-2uge"),
		kitName: "stub",
		policy,
		state: { version: 1, since: "2026-10-07T00:00:00.000Z", importedFrom: null, cards: {} },
		limits: { maxFailRounds: 3 },
		inspectSubmission: async () => ({ hasWork: true, records: [] }),
		now: Date.parse("2026-10-07T10:00:00.000Z"),
	});
	const agentByCard = new Map<string, string | undefined>();
	for (const [call] of policy.qaPolicy.mock.calls) {
		agentByCard.set(call.dev.card.id, call.dev.agentId);
	}
	return agentByCard;
}

describe("effective-agent incident (2026-10-06)", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	it("(a) a workspace with no kit and landing off gets no QA, land, rework or escalation for any card", async () => {
		const harness = createPipelineWorkerHarness({ config: {} });
		harnesses.push(harness);

		await harness.send(
			createSnapshot({ workspaceId: "kanban-2uge", board: createIncidentBoard(), selectedAgentId: "claude" }),
		);

		expect(harness.readDecisions("kanban-2uge")).toEqual([]);
		expect(harness.events).toEqual([]);
		// Not even a state file: the pipeline never looked at the workspace.
		expect(() => statSync(harness.statePath("kanban-2uge"))).toThrow();
		expect(harness.messages).toContainEqual({
			type: "evaluated",
			workspaceId: "kanban-2uge",
			decisions: 0,
			logged: 0,
		});
	});

	it("(a) the auto-review reconciler arms none of the board's cards", async () => {
		const store = createWorkspaceStateStore({ board: createIncidentBoard(), sessions: {}, revision: 1 });
		const deliverTaskInput = vi.fn();
		const probeTaskWorkspace = vi.fn(async () => ({ exists: true, headCommit: "head", changedFiles: 3 }));
		const reconciler = createAutoReviewReconciler({
			listWorkspaces: () => [
				{
					workspaceId: "kanban-2uge",
					workspacePath: "/repo",
					terminalManager: { getSummary: () => ({ taskId: "x" }) } as unknown as TerminalSessionManager,
				},
			],
			getWorkspaceState: store.getWorkspaceState,
			mutateWorkspaceState: store.mutateWorkspaceState,
			getPromptTemplates: async () => null,
			getSelectedAgentId: async () => "claude",
			deliverTaskInput,
			probeTaskWorkspace,
			trashTask: vi.fn(),
		});

		await reconciler.evaluateWorkspace("kanban-2uge");
		reconciler.close();

		expect(deliverTaskInput).not.toHaveBeenCalled();
		expect(probeTaskWorkspace).not.toHaveBeenCalled();
		expect(store.stored.revision).toBe(1);
	});

	it("(a) the default kit on landing qa never asks for QA: every card waits for Approve & land", async () => {
		const harness = createPipelineWorkerHarness({
			config: { workspaces: { "kanban-2uge": { landing: { mode: "qa" } } } },
		});
		harnesses.push(harness);

		await harness.send(
			createSnapshot({ workspaceId: "kanban-2uge", board: createIncidentBoard(), selectedAgentId: "claude" }),
		);

		const decisions = harness.readCardDecisions("kanban-2uge");
		expect(decisions.map((decision) => decision.taskId)).toEqual(["unpinned", "pinned-claude", "pinned-cline"]);
		for (const decision of decisions) {
			expect(decision.kit).toBe("default");
			expect(decision.answer).toMatchObject({ kind: "none" });
			expect(decision.outcome).toBe("none");
		}
		expect(harness.events).toEqual([]);
	});

	it("(b) the policy gets the effective agent: claude for the unpinned card, never cline, never undefined", async () => {
		const agents = await askStubPolicy({ selectedAgentId: "claude" });

		expect(agents.get("unpinned")).toBe("claude");
		expect(agents.get("pinned-claude")).toBe("claude");
		expect(agents.get("pinned-cline")).toBe("cline");
		expect([...agents.values()]).not.toContain(undefined);
	});

	it("(c) a second workspace on kit team in the same config does not change the first one", async () => {
		const harness = createPipelineWorkerHarness({
			config: { workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" } } } },
		});
		harnesses.push(harness);

		await harness.send(
			createSnapshot({ workspaceId: "foo", board: createIncidentBoard(), selectedAgentId: "claude" }),
		);
		await harness.send(
			createSnapshot({ workspaceId: "kanban-2uge", board: createIncidentBoard(), selectedAgentId: "claude" }),
		);

		// foo is on team: its cards are QA'd (the routing really is there to inherit).
		expect(harness.readCardDecisions("foo").some((decision) => decision.outcome === "not_implemented")).toBe(true);
		// kanban-2uge inherits nothing from it.
		expect(harness.readDecisions("kanban-2uge")).toEqual([]);
		expect(harness.events).toEqual([]);
	});

	it("(d) the selected agent changes to cline while a Claude session runs: the card is still Claude", async () => {
		const agents = await askStubPolicy({
			selectedAgentId: "cline",
			sessions: [{ taskId: "unpinned", agentId: "claude" }],
		});

		expect(agents.get("unpinned")).toBe("claude");
		// A card with no session follows the new selection; a pinned card keeps its pin.
		expect(agents.get("pinned-claude")).toBe("claude");
	});

	it("(d) the reconciler delivers to the agent the session runs on, not the selected one", async () => {
		const store = createWorkspaceStateStore({
			board: createBoard({ review: [createCard({ id: "unpinned", autoReviewEnabled: true })] }),
			sessions: {},
			revision: 1,
		});
		const deliverTaskInput = vi.fn(async () => ({
			ok: true,
			status: "delivered" as const,
			evidence: "hook" as const,
			enterAttempts: 1,
			summary: null,
		}));
		const reconciler = createAutoReviewReconciler({
			listWorkspaces: () => [
				{
					workspaceId: "kanban-2uge",
					workspacePath: "/repo",
					terminalManager: {
						getSummary: () => ({ taskId: "unpinned", agentId: "claude" }),
					} as unknown as TerminalSessionManager,
				},
			],
			getWorkspaceState: store.getWorkspaceState,
			mutateWorkspaceState: store.mutateWorkspaceState,
			getPromptTemplates: async () => null,
			getSelectedAgentId: async () => "cline",
			deliverTaskInput,
			probeTaskWorkspace: async () => ({ exists: true, headCommit: "head", changedFiles: 3 }),
			trashTask: vi.fn(),
		});

		await reconciler.evaluateWorkspace("kanban-2uge");
		await vi.waitFor(() => expect(deliverTaskInput).toHaveBeenCalled());
		reconciler.close();

		expect(deliverTaskInput).toHaveBeenCalledWith(
			expect.anything(),
			"unpinned",
			expect.any(String),
			expect.objectContaining({ agentId: "claude" }),
		);
	});

	it("(e) no core module compares an agent id to a string literal", () => {
		const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
		const coreRoots = [
			"src/pipeline",
			"src/kits",
			"src/core/effective-agent.ts",
			"src/server/auto-review-reconciler.ts",
			"src/server/session-column-sync.ts",
		];
		const ids = runtimeAgentIdEnumSchema.options.join("|");
		const comparison = new RegExp(
			`(?:[!=]==?\\s*["'\`](?:${ids})["'\`])|(?:["'\`](?:${ids})["'\`]\\s*[!=]==?)|(?:case\\s+["'\`](?:${ids})["'\`])`,
			"u",
		);
		const listFiles = (path: string): string[] =>
			statSync(path).isDirectory()
				? readdirSync(path).flatMap((entry) => listFiles(join(path, entry)))
				: /\.ts$/u.test(path)
					? [path]
					: [];
		const violations: string[] = [];
		for (const root of coreRoots) {
			for (const file of listFiles(join(repoRoot, root))) {
				readFileSync(file, "utf8")
					.split("\n")
					.forEach((line, index) => {
						if (comparison.test(line)) {
							violations.push(`${relative(repoRoot, file).split(sep).join("/")}:${index + 1}: ${line.trim()}`);
						}
					});
			}
		}
		expect(violations, "Decide on resolveEffectiveAgent() and ask the kit instead").toEqual([]);
		// The gate itself still catches the incident's form.
		expect(comparison.test('if (card.agentId === "claude") return;')).toBe(true);
		expect(comparison.test("case 'cline':")).toBe(true);
	});
});
