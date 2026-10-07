import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPipelineDecisionLog, type PipelineDecisionRecord } from "../../../src/pipeline/decision-log";
import { createPipelineStateStore, importLegacyChecksState } from "../../../src/pipeline/pipeline-state";
import {
	getKanbanWorkspaceDataPath,
	getLegacyKitChecksStatePaths,
	getPipelineDecisionLogPath,
	getPipelineStatePath,
} from "../../../src/state/kanban-home";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";

const NOW = Date.parse("2026-10-07T10:00:00.000Z");

describe("pipeline state store", () => {
	const temps: Array<{ cleanup: () => void }> = [];
	const tempRoot = () => {
		const temp = createTempDir("kanban-pipeline-state-");
		temps.push(temp);
		return temp.path;
	};
	afterEach(() => {
		for (const temp of temps.splice(0)) {
			temp.cleanup();
		}
	});

	it("converts a legacy checks-state.json: bare strings are snapshots, `_` keys are not cards", () => {
		expect(
			importLegacyChecksState(
				{ _qaflow: { since: "2026-10-05T03:01:03.576Z" }, a: "sha", b: { qaflow: { lastRound: 1 } }, c: 3 },
				"/legacy/checks-state.json",
				"fallback",
			),
		).toEqual({
			version: 1,
			since: "2026-10-05T03:01:03.576Z",
			importedFrom: "/legacy/checks-state.json",
			cards: { a: { snapshot: "sha" }, b: { qaflow: { lastRound: 1 } } },
		});
		expect(importLegacyChecksState([], "/x", "fallback")).toBeNull();
		expect(importLegacyChecksState({ _qaflow: { since: "nope" } }, "/x", "fallback")?.since).toBe("fallback");
	});

	it("creates a fresh state with `since` = now when there is nothing to import, and keeps it across loads", async () => {
		const root = tempRoot();
		let now = NOW;
		const store = createPipelineStateStore({
			now: () => now,
			getStatePath: (workspaceId) => join(root, workspaceId, "pipeline-state.json"),
			getLegacyChecksStatePaths: (workspaceId) => [join(root, "legacy", workspaceId, "checks-state.json")],
		});

		const first = await store.load("foo");
		now += 60_000;
		const second = await store.load("foo");

		expect(first).toEqual({ version: 1, since: "2026-10-07T10:00:00.000Z", importedFrom: null, cards: {} });
		expect(second.since).toBe(first.since);
		const updated = await store.update("foo", (state) => ({ ...state, cards: { "dev-1": { snapshot: "x" } } }));
		expect(updated.cards["dev-1"]).toEqual({ snapshot: "x" });
		expect(JSON.parse(readFileSync(join(root, "foo", "pipeline-state.json"), "utf8")).cards["dev-1"]).toEqual({
			snapshot: "x",
		});
	});

	it("refuses to overwrite a state file it can't read", async () => {
		const root = tempRoot();
		const path = join(root, "foo", "pipeline-state.json");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ version: 2, cards: {} }));
		const store = createPipelineStateStore({
			getStatePath: () => path,
			getLegacyChecksStatePaths: () => [],
		});

		await expect(store.load("foo")).rejects.toThrow(/not a version 1 pipeline state/u);
		await expect(store.update("foo", (state) => state)).rejects.toThrow(/not a version 1 pipeline state/u);
		expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
	});

	it("keeps its files under <home>/data/<workspace> and looks for the legacy kit's state there and in ~/.kanban/data", async () => {
		await withTemporaryKanbanHome(
			({ homePath, userHomePath }) => {
				expect(getKanbanWorkspaceDataPath("foo")).toBe(join(homePath, "data", "foo"));
				expect(getPipelineStatePath("foo")).toBe(join(homePath, "data", "foo", "pipeline-state.json"));
				expect(getPipelineDecisionLogPath("foo")).toBe(join(homePath, "data", "foo", "pipeline-decisions.jsonl"));
				expect(getLegacyKitChecksStatePaths("foo")).toEqual([
					join(homePath, "data", "foo", "checks-state.json"),
					join(userHomePath, ".kanban", "data", "foo", "checks-state.json"),
				]);
			},
			{ layout: "legacy" },
		);
	});
});

describe("pipeline decision log", () => {
	function record(workspaceId: string, taskId: string): PipelineDecisionRecord {
		return {
			at: "2026-10-07T10:00:00.000Z",
			workspaceId,
			taskId,
			stage: "qa_gate",
			kit: "default",
			landingMode: "qa",
			shadow: false,
			effectiveAgent: { agentId: "claude", source: "selected" },
			model: null,
			role: "dev",
			answer: { kind: "none", reason: "x" },
			outcome: "none",
			note: "n",
		};
	}

	it("appends one JSON line per record in order, per workspace, and rotates a full log", async () => {
		const temp = createTempDir("kanban-pipeline-log-");
		try {
			const logPath = (workspaceId: string) => join(temp.path, workspaceId, "pipeline-decisions.jsonl");
			const log = createPipelineDecisionLog({ getLogPath: logPath, maxBytes: 1_000 });

			await Promise.all([log.append([record("foo", "a"), record("bar", "b")]), log.append([record("foo", "c")])]);
			const lines = (workspaceId: string) =>
				readFileSync(logPath(workspaceId), "utf8")
					.trim()
					.split("\n")
					.map((line) => (JSON.parse(line) as PipelineDecisionRecord).taskId);
			expect(lines("foo")).toEqual(["a", "c"]);
			expect(lines("bar")).toEqual(["b"]);

			await log.append([record("foo", "d"), record("foo", "e")]);
			expect(lines("foo")).toEqual(["d", "e"]);
			expect(statSync(`${logPath("foo")}.1`).size).toBeGreaterThan(0);
		} finally {
			temp.cleanup();
		}
	});
});
