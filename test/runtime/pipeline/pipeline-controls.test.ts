import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { createPipelineStateStore } from "../../../src/pipeline/pipeline-state";
import { readCurrentTriageAck } from "../../../src/pipeline/triage-acknowledgement";
import { createPipelineControlApi } from "../../../src/server/pipeline-control";
import { createTempDir } from "../../utilities/temp-dir";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

describe("supported pipeline controls", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});
	function setup() {
		const temp = createTempDir("controls-");
		cleanups.push(temp.cleanup);
		const store = createPipelineStateStore({
			getStatePath: (id) => join(temp.path, id, "state.json"),
			getLegacyChecksStatePaths: () => [],
		});
		const board = createBoard({
			backlog: [createCard({ id: "d1111", role: "dev", title: "BLOCKED: benchmark" }), createCard({ id: "d2222" })],
		});
		const wake = vi.fn();
		const api = createPipelineControlApi({
			store,
			readBoard: async () => board,
			isLive: () => false,
			wake,
			now: () => Date.parse("2026-10-16T18:00:00Z"),
		});
		return { store, board, api, wake };
	}
	const ack = {
		kind: "acknowledge" as const,
		taskId: "d1111",
		disposition: "deferred" as const,
		reason: "wait for independent QA",
		waitForTaskId: "d2222",
		until: "2026-10-16T19:00:00Z",
	};
	it("persists acknowledgement, preserves escalation/verdicts and invalidates on expiry/prerequisite evidence", async () => {
		const { store, board, api } = setup();
		await store.update("foo", (state) => ({
			...state,
			cards: {
				d1111: {
					snapshot: "snap",
					qaflow: { escalated: { at: "2026-10-16T17:00:00Z", reason: "tooling" } },
					qaVerdicts: [],
				},
				d2222: { snapshot: "wait" },
			},
		}));
		expect(await api.request({ kind: "user" }, "foo", ack)).toMatchObject({ ok: true });
		const state = await store.load("foo");
		expect(state.cards.d1111?.qaflow).toMatchObject({ escalated: { reason: "tooling" } });
		expect(state.cards.d1111?.qaVerdicts).toEqual([]);
		expect(readCurrentTriageAck(board, state.cards, "d1111", Date.parse("2026-10-16T18:30:00Z"))?.disposition).toBe(
			"deferred",
		);
		expect(readCurrentTriageAck(board, state.cards, "d1111", Date.parse(ack.until))).toBeNull();
		const changed = { ...state.cards, d2222: { ...state.cards.d2222, qaVerdicts: [{ verdict: "STALLED" }] } };
		expect(readCurrentTriageAck(board, changed, "d1111", Date.parse("2026-10-16T18:30:00Z"))).toBeNull();
	});
	it("refuses unknown, card and cross-workspace callers before reading or mutating state", async () => {
		const { api, store, wake } = setup();
		const callers: RuntimeCaller[] = [
			{ kind: "unknown", reason: "missing credential" },
			{
				kind: "session",
				via: "credential",
				session: { workspaceId: "foo", taskId: "d1111", role: "card", agentId: "claude", cwd: "/projects/foo" },
			},
			{
				kind: "session",
				via: "credential",
				session: {
					workspaceId: "bar",
					taskId: "__home_agent__:bar:claude",
					role: "orchestrator",
					agentId: "claude",
					cwd: "/projects/bar",
				},
			},
		];
		for (const caller of callers) expect(await api.request(caller, "foo", ack)).toMatchObject({ ok: false });
		expect(await store.peek("foo")).toBeNull();
		expect(wake).not.toHaveBeenCalled();
	});
	it("refuses stale snapshots, Done targets and nonexistent prerequisites instead of reopening evidence", async () => {
		const { api, store, board } = setup();
		await store.update("foo", (state) => ({ ...state, cards: { d1111: { snapshot: "current" } } }));
		expect(
			await api.request({ kind: "user" }, "foo", {
				kind: "review",
				taskId: "d1111",
				snapshot: "old",
				reason: "explicit check",
				evidenceOnly: true,
			}),
		).toMatchObject({ ok: false, error: expect.stringContaining("Snapshot changed") });
		board.columns.find((column) => column.id === "trash")?.cards.push(createCard({ id: "gone" }));
		expect(
			await api.request({ kind: "user" }, "foo", {
				kind: "review",
				taskId: "gone",
				snapshot: "current",
				reason: "check",
				evidenceOnly: true,
			}),
		).toMatchObject({ ok: false, error: expect.stringContaining("Done") });
	});
});
