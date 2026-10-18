import { describe, expect, it } from "vitest";
import { TASK_EXECUTION_BLOCK_EVENT } from "../../../src/core/task-execution-block";
import { createPipelineWorkerHarness, createSnapshot } from "../../utilities/pipeline-worker";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

describe("an execution refusal is not a QA candidate (#66)", () => {
	it("neither submits interrupted work nor consumes an older PASS as permission to land", async () => {
		const h = createPipelineWorkerHarness({
			config: { workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "legacy-team" } } } },
		});
		try {
			await h.store.update("foo", (state) => {
				state.cards.dev01 = {
					qaVerdicts: [
						{
							qaTaskId: "qa001",
							round: 1,
							snapshot: "snap-dev01",
							verdict: "PASS",
							blocking: [],
							notes: "earlier evidence",
							scores: null,
							visual: null,
							artifactsDir: null,
							at: Date.parse("2026-10-07T09:59:00Z"),
						},
					],
				};
				return state;
			});
			await h.send(
				createSnapshot({
					workspaceId: "foo",
					selectedAgentId: "claude",
					board: createBoard({ review: [createCard({ id: "dev01" })] }),
					sessions: [
						{
							taskId: "dev01",
							state: "awaiting_review",
							reviewReason: "error",
							latestHookActivity: {
								source: "cline-guard",
								hookEventName: TASK_EXECUTION_BLOCK_EVENT,
								activityText: "cancelled",
								toolName: null,
								toolInputSummary: null,
								finalMessage: null,
								notificationType: "execution_blocked",
							},
						},
					],
				}),
			);
			expect(h.actions).toEqual([]);
			expect(h.readCardDecisions("foo").some((record) => record.note.includes("incomplete turn"))).toBe(true);
			expect((await h.store.load("foo")).cards.dev01?.qaPass).toBeUndefined();
		} finally {
			h.cleanup();
		}
	});
});
