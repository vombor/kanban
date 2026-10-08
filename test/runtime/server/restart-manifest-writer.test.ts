import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { RestartManifest } from "../../../src/pipeline/restart-recovery";
import {
	type CreateRestartManifestWriterDependencies,
	createRestartManifestWriter,
	type RestartManifestWorkspaceView,
} from "../../../src/server/restart-manifest-writer";

const SERVER_START = Date.parse("2026-10-08T10:00:00.000Z");
const PREVIOUS_START = SERVER_START - 86_400_000;

function card(id: string, extra: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: `Prompt of ${id}.`,
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

function summary(taskId: string, state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return { taskId, state, modelId: null } as unknown as RuntimeTaskSessionSummary;
}

function createHarness(options: { manifest?: RestartManifest | null; now?: number } = {}) {
	let manifest = options.manifest ?? null;
	let now = options.now ?? SERVER_START + 60 * 60_000;
	const writes: RestartManifest[] = [];
	const locks: string[] = [];
	let view: RestartManifestWorkspaceView = {
		board: board({
			in_progress: [card("dev1"), card("cal", { role: "calibration" })],
			review: [card("dev2"), card("qa1", { role: "qa" })],
		}),
		sessions: {
			dev1: summary("dev1", "running"),
			cal: summary("cal", "running"),
			dev2: summary("dev2", "awaiting_review"),
			qa1: summary("qa1", "running"),
		},
	};
	const deps: CreateRestartManifestWriterDependencies = {
		listWorkspaceIds: () => ["foo"],
		loadWorkspace: async () => view,
		serverStartedAt: SERVER_START,
		previousServerStartedAt: PREVIOUS_START,
		readManifest: async () => manifest,
		writeManifest: async (_workspaceId, next) => {
			manifest = next;
			writes.push(next);
		},
		now: () => now,
		withManifestLock: async (_workspaceId, operation) => {
			locks.push("in");
			try {
				return await operation();
			} finally {
				locks.push("out");
			}
		},
	};
	return {
		deps,
		writes,
		locks,
		getManifest: () => manifest,
		setManifest: (next: RestartManifest | null) => {
			manifest = next;
		},
		setView: (next: RestartManifestWorkspaceView) => {
			view = next;
		},
		getView: () => view,
		setNow: (next: number) => {
			now = next;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("restart manifest writer", () => {
	it("lists the running In Progress / Review cards as `kanban restart prepare` does, without WIP tags", async () => {
		const harness = createHarness();
		const writer = createRestartManifestWriter(harness.deps);
		await writer.writeAll("periodic");
		expect(harness.getManifest()).toEqual({
			at: new Date(SERVER_START + 60 * 60_000).toISOString(),
			kanbanStart: new Date(SERVER_START).toISOString(),
			source: "periodic",
			cards: [
				{ id: "dev1", column: "in_progress", model: null, wipTag: null, kind: "dev" },
				{ id: "qa1", column: "review", model: null, wipTag: null, kind: "qa" },
			],
		});
		await writer.close();
	});

	const previousManifest = (): RestartManifest => ({
		at: new Date(SERVER_START - 3 * 60_000).toISOString(),
		kanbanStart: new Date(PREVIOUS_START).toISOString(),
		source: "periodic",
		cards: [{ id: "dev1", column: "in_progress" }],
	});

	it("leaves the previous server's manifest to restart recovery for the handover time", async () => {
		const harness = createHarness({ manifest: previousManifest(), now: SERVER_START + 60_000 });
		const writer = createRestartManifestWriter(harness.deps);
		await writer.writeAll("periodic");
		expect(harness.writes).toEqual([]);
		// Nothing read it (recovery off for this workspace): it is stale for the next start anyway.
		harness.setNow(SERVER_START + 11 * 60_000);
		await writer.writeAll("periodic");
		expect(harness.getManifest()?.kanbanStart).toBe(new Date(SERVER_START).toISOString());
		await writer.close();
	});

	it("never holds the shutdown write for the handover (a second restart within it keeps this server's manifest)", async () => {
		const harness = createHarness({ manifest: previousManifest(), now: SERVER_START + 60_000 });
		const writer = createRestartManifestWriter(harness.deps);
		writer.start();
		await writer.close({ finalSource: "shutdown" });
		expect(harness.writes.map((write) => [write.source, write.kanbanStart])).toEqual([
			["shutdown", new Date(SERVER_START).toISOString()],
		]);
	});

	it("ends the handover once recovery has planned with the manifest, or the file is no longer the one it found", async () => {
		const planned = createHarness({ manifest: previousManifest(), now: SERVER_START + 60_000 });
		const writer = createRestartManifestWriter(planned.deps);
		writer.start();
		await writer.writeAll("periodic");
		expect(planned.writes).toEqual([]);
		// Restart recovery planned (it keeps the file until its resumes are done): a crash now needs this server's.
		planned.setManifest({ ...previousManifest(), plannedAt: new Date(SERVER_START + 90_000).toISOString() });
		await writer.writeAll("periodic");
		expect(planned.writes.map((write) => write.kanbanStart)).toEqual([new Date(SERVER_START).toISOString()]);
		await writer.close();

		// Replaced since this server started (an older one put back, or another writer's): not the one to wait for.
		const replaced = createHarness({ manifest: previousManifest(), now: SERVER_START + 60_000 });
		const second = createRestartManifestWriter(replaced.deps);
		second.start();
		await second.writeAll("periodic");
		replaced.setManifest({ ...previousManifest(), at: new Date(SERVER_START - 2 * 60_000).toISOString() });
		await second.writeAll("periodic");
		expect(replaced.writes).toHaveLength(1);
		await second.close();
	});

	it("reads, checks and writes under the manifest's file lock", async () => {
		const harness = createHarness();
		const writer = createRestartManifestWriter({
			...harness.deps,
			writeManifest: async (workspaceId, next) => {
				expect(harness.locks.at(-1)).toBe("in");
				await harness.deps.writeManifest?.(workspaceId, next);
			},
		});
		await writer.writeAll("periodic");
		expect(harness.locks).toEqual(["in", "out"]);
		expect(harness.writes).toHaveLength(1);
		await writer.close();
	});

	it("keeps a fresh `kanban restart prepare` manifest of this server, then replaces it without its WIP tags", async () => {
		const prepared: RestartManifest = {
			at: new Date(SERVER_START + 50 * 60_000).toISOString(),
			kanbanStart: new Date(SERVER_START).toISOString(),
			source: "prepare",
			cards: [{ id: "dev1", column: "in_progress", wipTag: "preserve/dev1-wip-20261008T1050-restart" }],
		};
		const harness = createHarness({ manifest: prepared });
		const writer = createRestartManifestWriter(harness.deps);
		await writer.writeAll("periodic");
		// The planned restart's shutdown keeps it too.
		await writer.close({ finalSource: "shutdown" });
		expect(harness.writes).toEqual([]);

		// No restart came: after the hold the server's manifest takes over. The old tag would not hold the work done
		// since, so it is not carried over: recovery tags fresh at resume.
		harness.setNow(SERVER_START + 81 * 60_000);
		const later = createRestartManifestWriter(harness.deps);
		await later.writeAll("periodic");
		expect(harness.getManifest()).toMatchObject({
			source: "periodic",
			cards: [
				{ id: "dev1", wipTag: null },
				{ id: "qa1", wipTag: null },
			],
		});
		await later.close();
	});

	it("writes once at shutdown with source shutdown", async () => {
		const harness = createHarness();
		const writer = createRestartManifestWriter(harness.deps);
		await writer.close({ finalSource: "shutdown" });
		expect(harness.writes.map((write) => write.source)).toEqual(["shutdown"]);
		// Closed: nothing more.
		await writer.writeAll("periodic");
		writer.notifyActivity({ workspaceId: "foo" });
		expect(harness.writes).toHaveLength(1);
	});

	it("refreshes periodically and, debounced, on state and board changes only", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		const writer = createRestartManifestWriter({ ...harness.deps, intervalMs: 300_000, debounceMs: 15_000 });
		writer.start();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(harness.writes).toHaveLength(1);

		// Output-only summaries: no write.
		writer.notifyActivity({ workspaceId: "foo", summary: summary("dev1", "running") });
		await vi.advanceTimersByTimeAsync(15_000);
		writer.notifyActivity({ workspaceId: "foo", summary: summary("dev1", "running") });
		await vi.advanceTimersByTimeAsync(15_000);
		expect(harness.writes).toHaveLength(1);

		// dev1's turn ends: one write, 15 s later, without it.
		harness.setView({
			...harness.getView(),
			sessions: { ...harness.getView().sessions, dev1: summary("dev1", "awaiting_review") },
		});
		writer.notifyActivity({ workspaceId: "foo", summary: summary("dev1", "awaiting_review") });
		writer.notifyActivity({ workspaceId: "foo" });
		await vi.advanceTimersByTimeAsync(14_000);
		expect(harness.writes).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(harness.writes).toHaveLength(2);
		expect(harness.writes[1]?.cards.map((entry) => entry.id)).toEqual(["qa1"]);

		// A board change that changes nothing listed writes nothing; the periodic refresh always writes.
		writer.notifyActivity({ workspaceId: "foo" });
		await vi.advanceTimersByTimeAsync(15_000);
		expect(harness.writes).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(300_000 - 75_000);
		expect(harness.writes).toHaveLength(3);
		expect(harness.writes[2]?.source).toBe("periodic");
		await writer.close();
	});
});
