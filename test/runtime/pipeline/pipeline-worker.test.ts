import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPipelineWorkerHarness, createSnapshot } from "../../utilities/pipeline-worker";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const QA_WORKSPACE = { landing: { mode: "qa" }, kit: { name: "team" } };

describe("pipeline worker", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	const createHarness = (...args: Parameters<typeof createPipelineWorkerHarness>) => {
		const harness = createPipelineWorkerHarness(...args);
		harnesses.push(harness);
		return harness;
	};
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	it("logs a watching record and one decision per submitted card, and an unchanged answer only once", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		const snapshot = createSnapshot({
			workspaceId: "foo",
			board: createBoard({ review: [createCard({ id: "dev-1" })], in_progress: [createCard({ id: "dev-2" })] }),
			selectedAgentId: "claude",
		});

		await harness.send(snapshot);
		await harness.send(snapshot);

		const records = harness.readDecisions("foo");
		expect(records.map((record) => [record.stage, record.taskId])).toEqual([
			["worker", null],
			["qa_gate", "dev-1"],
		]);
		expect(records[0]?.note).toContain("watching: landing qa, kit team");
		expect(records[1]).toMatchObject({
			kit: "team",
			landingMode: "qa",
			shadow: false,
			role: "dev",
			effectiveAgent: { agentId: "claude", source: "selected" },
			answer: { kind: "qa", agentId: "codex" },
			// The QA gate itself is a later card: the skeleton decides and records only.
			outcome: "not_implemented",
		});
		expect(harness.messages).toContainEqual({ type: "evaluated", workspaceId: "foo", decisions: 1, logged: 0 });
		expect(harness.events).toEqual([]);
	});

	it("marks decisions on a shadow workspace as shadow", async () => {
		const harness = createHarness({
			config: { workspaces: { foo: { ...QA_WORKSPACE, pipeline: { shadow: true } } } },
		});

		await harness.send(
			createSnapshot({
				workspaceId: "foo",
				board: createBoard({ review: [createCard({ id: "dev-1" })] }),
				selectedAgentId: "claude",
			}),
		);

		expect(harness.readCardDecisions("foo")).toMatchObject([{ shadow: true, outcome: "shadow" }]);
	});

	it("skips cards without work and cards the auto-review reconciler owns; never QAs a non-dev role", async () => {
		const harness = createHarness({
			config: { workspaces: { foo: QA_WORKSPACE } },
			hasWork: (card) => card.id !== "planning",
		});

		await harness.send(
			createSnapshot({
				workspaceId: "foo",
				board: createBoard({
					review: [
						createCard({ id: "planning" }),
						createCard({ id: "auto-commit", autoReviewEnabled: true, autoReviewMode: "commit" }),
						createCard({ id: "qa-mode", autoReviewEnabled: true, autoReviewMode: "qa" }),
						createCard({ id: "qa-card", role: "qa" }),
					],
				}),
				selectedAgentId: "claude",
			}),
		);

		const decisions = harness.readCardDecisions("foo");
		expect(decisions.map((decision) => decision.taskId)).toEqual(["qa-mode", "qa-card"]);
		expect(decisions[1]).toMatchObject({ role: "qa", answer: { kind: "none" }, outcome: "none" });
	});

	it("picks up a landing-mode or kit change on the next snapshot, with no restart", async () => {
		const harness = createHarness({ config: {} });
		const snapshot = createSnapshot({
			workspaceId: "foo",
			board: createBoard({ review: [createCard({ id: "dev-1" })] }),
			selectedAgentId: "claude",
		});

		await harness.send(snapshot);
		expect(harness.readDecisions("foo")).toEqual([]);

		harness.setConfig({ workspaces: { foo: { landing: { mode: "qa" } } } });
		await harness.send(snapshot);
		expect(harness.readCardDecisions("foo")).toMatchObject([{ kit: "default", answer: { kind: "none" } }]);

		harness.setConfig({ workspaces: { foo: QA_WORKSPACE } });
		await harness.send(snapshot);
		expect(harness.readCardDecisions("foo").at(-1)).toMatchObject({ kit: "team", answer: { kind: "qa" } });

		harness.setConfig({ workspaces: { foo: QA_WORKSPACE }, pipeline: { paused: true } });
		const before = harness.readDecisions("foo").length;
		await harness.send(snapshot);
		expect(harness.readDecisions("foo")).toHaveLength(before);
		expect(harness.messages).toContainEqual({ type: "log", message: "pipeline foo: not watched any more" });
	});

	it("falls back to the default kit when the workspace's kit doesn't resolve, and says so once", async () => {
		const harness = createHarness({
			config: { workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "missing" } } } },
		});
		const snapshot = createSnapshot({
			workspaceId: "foo",
			board: createBoard({ review: [createCard({ id: "dev-1" })] }),
			selectedAgentId: "claude",
		});

		await harness.send(snapshot);
		await harness.send(snapshot);

		expect(harness.readCardDecisions("foo")).toMatchObject([{ kit: "default", answer: { kind: "none" } }]);
		const kitIssues = harness.messages.filter(
			(message) => message.type === "log" && message.message.includes('unknown kit "missing"'),
		);
		expect(kitIssues).toHaveLength(1);
	});

	it("imports the legacy checks-state.json once and reads FAIL rounds and handbacks from it", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		const legacyPath = `${harness.legacyDir}/foo/checks-state.json`;
		mkdirSync(dirname(legacyPath), { recursive: true });
		writeFileSync(
			legacyPath,
			JSON.stringify({
				_qaflow: { since: "2026-10-05T03:01:03.576Z" },
				"dev-1": {
					snapshot: "abc",
					qaflow: { lastRound: 2, failRounds: [1, 2], handbacks: [{ at: "x", extraRounds: 2 }] },
				},
				"old-1": "deadbeef",
			}),
		);

		await harness.send(
			createSnapshot({
				workspaceId: "foo",
				board: createBoard({ review: [createCard({ id: "dev-1" })] }),
				selectedAgentId: "claude",
			}),
		);

		const state = JSON.parse(readFileSync(harness.statePath("foo"), "utf8"));
		expect(state).toMatchObject({
			version: 1,
			since: "2026-10-05T03:01:03.576Z",
			importedFrom: legacyPath,
			cards: { "dev-1": { snapshot: "abc" }, "old-1": { snapshot: "deadbeef" } },
		});
		expect(harness.readCardDecisions("foo")[0]?.note).toMatch(/^round 3:/u);
		// Read-only: the legacy file is untouched.
		expect(JSON.parse(readFileSync(legacyPath, "utf8"))["old-1"]).toBe("deadbeef");
	});
});
