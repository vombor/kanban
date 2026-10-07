import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import type { PipelineSessionView } from "../../../src/pipeline/engine";
import { findProviderCapacityHold } from "../../../src/pipeline/provider-capacity";
import {
	consumeRestartRecoveryRequest,
	isManifestForStart,
	planRestartRecovery,
	readRestartManifest,
	readRunningServerStart,
	readServerStartRecord,
	removeRestartManifest,
	requestRestartRecovery,
	writeRestartManifest,
	writeServerStartRecord,
} from "../../../src/pipeline/restart-recovery";
import { getRestartManifestPath, getRestartRecoverRequestPath } from "../../../src/state/kanban-home";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

const SERVER_START = Date.parse("2026-10-07T12:00:00.000Z");
const BEFORE = SERVER_START - 3_600_000;

function card(id: string, extra: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: "Do it.",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...extra,
	} as RuntimeBoardCard;
}

function session(taskId: string, extra: Partial<PipelineSessionView> = {}): PipelineSessionView {
	return { taskId, agentId: "cline", modelId: null, state: "running", startedAt: BEFORE, live: false, ...extra };
}

describe("planRestartRecovery", () => {
	it("finds the cards a restart left without a process, and only those (8a1bf34)", () => {
		const cards = [
			{ card: card("mid"), column: "in_progress" },
			{ card: card("interrupted"), column: "review" },
			{ card: card("finished"), column: "review" },
			{ card: card("idle-reply"), column: "review" },
			{ card: card("new"), column: "in_progress" },
			{ card: card("alive"), column: "in_progress" },
			{ card: card("blocked", { title: "BLOCKED: needs a key" }), column: "review" },
			{ card: card("backlog"), column: "backlog" },
			{
				card: card("qa1", { prompt: "You are the QA reviewer (round 1) for Kanban dev card mid" }),
				column: "in_progress",
			},
			{ card: card("cal", { title: "QA-CAL glm run 3" }), column: "in_progress" },
		];
		const sessions = new Map(
			[
				session("mid"),
				session("interrupted", { state: "interrupted" }),
				session("finished", { state: "awaiting_review" }),
				session("idle-reply"),
				session("new", { startedAt: SERVER_START + 1000 }),
				session("alive", { live: true }),
				session("blocked"),
				session("backlog"),
				session("qa1"),
				session("cal"),
			].map((entry) => [entry.taskId, entry]),
		);
		const plan = planRestartRecovery({
			cards,
			sessions,
			serverStartedAt: SERVER_START,
			previousServerStartedAt: null,
			manifest: null,
			// 1a7a32a: a Cline CLI session idle after a final reply is finished work.
			turnEnded: (entry) => entry.id === "idle-reply",
		});
		expect(plan.orphans.map((orphan) => [orphan.taskId, orphan.role, orphan.column])).toEqual([
			["mid", "dev", "in_progress"],
			["interrupted", "dev", "review"],
			["qa1", "qa", "in_progress"],
		]);
		expect(Object.fromEntries(plan.skipped.map((entry) => [entry.taskId, entry.why]))).toEqual({
			finished: "session awaiting_review before the restart: finished work",
			"idle-reply": "its turn had ended before the restart: finished work",
			blocked: "BLOCKED (escalated)",
			cal: "role calibration: left to its own runner",
		});
	});

	it("takes the restart manifest's cards as orphans with their WIP tags, if it predates the start", () => {
		const cards = [{ card: card("listed"), column: "review" }];
		const sessions = new Map([["listed", session("listed", { state: "awaiting_review" })]]);
		const previous = SERVER_START - 3_600_000;
		const manifest = {
			at: new Date(SERVER_START - 60_000).toISOString(),
			kanbanStart: new Date(previous).toISOString(),
			cards: [{ id: "listed", column: "review", wipTag: "preserve/listed-wip-20261007T1159-restart" }],
		};
		const used = planRestartRecovery({
			cards,
			sessions,
			serverStartedAt: SERVER_START,
			previousServerStartedAt: previous,
			manifest,
			turnEnded: () => true,
		});
		expect(used.manifestAt).toBe(manifest.at);
		expect(used.orphans).toMatchObject([{ taskId: "listed", wipTag: "preserve/listed-wip-20261007T1159-restart" }]);
		// A manifest written after this server started is for the next restart.
		const later = { ...manifest, at: new Date(SERVER_START + 60_000).toISOString() };
		expect(
			planRestartRecovery({
				cards,
				sessions,
				serverStartedAt: SERVER_START,
				previousServerStartedAt: previous,
				manifest: later,
				turnEnded: () => true,
			}).orphans,
		).toEqual([]);
	});
});

describe("restart manifest and recover requests", () => {
	it("uses a manifest only for the start right after the server that wrote it", () => {
		const at = new Date(SERVER_START - 60_000).toISOString();
		const previous = SERVER_START - 3_600_000;
		const writer = new Date(previous).toISOString();
		expect(isManifestForStart({ at, kanbanStart: writer, cards: [] }, SERVER_START, previous)).toBe(true);
		// Weeks old: written under a server two or more starts back (a landing-off workspace nothing planned).
		const old = new Date(previous - 21 * 86_400_000).toISOString();
		expect(isManifestForStart({ at: old, kanbanStart: old, cards: [] }, SERVER_START, previous)).toBe(false);
		// No writing server, or no record of the previous start: never replayed.
		expect(isManifestForStart({ at, kanbanStart: null, cards: [] }, SERVER_START, previous)).toBe(false);
		expect(isManifestForStart({ at, kanbanStart: writer, cards: [] }, SERVER_START, null)).toBe(false);
		// Written under this very server (a prepare that no restart followed yet).
		expect(
			isManifestForStart(
				{ at, kanbanStart: new Date(SERVER_START).toISOString(), cards: [] },
				SERVER_START,
				previous,
			),
		).toBe(false);
		expect(isManifestForStart(null, SERVER_START, previous)).toBe(false);
	});

	it("reads the previous server's start record whether or not that server still runs", async () => {
		await withTemporaryKanbanHome(async () => {
			expect(await readServerStartRecord()).toBeNull();
			await writeServerStartRecord({ pid: 99_999_999, startedAt: SERVER_START });
			expect(await readServerStartRecord()).toEqual({ pid: 99_999_999, startedAt: SERVER_START });
		});
	});

	it("records the running server's start for restart prepare", async () => {
		await withTemporaryKanbanHome(async () => {
			expect(await readRunningServerStart(() => true)).toBeNull();
			await writeServerStartRecord({ pid: 4242, startedAt: SERVER_START });
			expect(await readRunningServerStart((pid) => pid === 4242)).toBe(SERVER_START);
			// The server that wrote it is gone.
			expect(await readRunningServerStart(() => false)).toBeNull();
		});
	});

	it("round-trips the manifest in the workspace data dir", async () => {
		await withTemporaryKanbanHome(async () => {
			expect(await readRestartManifest("foo")).toBeNull();
			const manifest = { at: "2026-10-07T11:59:00.000Z", kanbanStart: null, cards: [{ id: "a", column: "review" }] };
			const path = await writeRestartManifest("foo", manifest);
			expect(path).toBe(getRestartManifestPath("foo"));
			expect(await readRestartManifest("foo")).toEqual(manifest);
			await removeRestartManifest("foo");
			expect(existsSync(path)).toBe(false);
		});
	});

	it("consumes one workspace's recover request and keeps the others'", async () => {
		await withTemporaryKanbanHome(async () => {
			expect(await consumeRestartRecoveryRequest("foo")).toBe(false);
			await requestRestartRecovery("foo");
			await requestRestartRecovery("bar");
			expect(await consumeRestartRecoveryRequest("baz")).toBe(false);
			expect(await consumeRestartRecoveryRequest("foo")).toBe(true);
			expect(await consumeRestartRecoveryRequest("foo")).toBe(false);
			expect(readFileSync(getRestartRecoverRequestPath(), "utf8")).toMatch(/ bar\n$/);
			expect(await consumeRestartRecoveryRequest("bar")).toBe(true);
			expect(existsSync(getRestartRecoverRequestPath())).toBe(false);
		});
	});
});

describe("findProviderCapacityHold (1ce45df)", () => {
	const capacity = { lemonade: { maxLoadedModels: 1 } };
	const lemonade = (model: string) => ({ provider: "lemonade", model });

	it("holds a card while another card has a different model loaded on a one-model provider", () => {
		const hold = findProviderCapacityHold({
			taskId: "me",
			model: lemonade("glm"),
			inProgress: [{ taskId: "other", model: lemonade("qwen") }],
			capacity,
		});
		expect(hold).toEqual({ provider: "lemonade", maxLoadedModels: 1, holders: ["other (qwen)"] });
	});

	it("lets the same model, other providers and providers without a limit through", () => {
		const other = [{ taskId: "other", model: lemonade("glm") }];
		expect(
			findProviderCapacityHold({ taskId: "me", model: lemonade("glm"), inProgress: other, capacity }),
		).toBeNull();
		expect(
			findProviderCapacityHold({
				taskId: "me",
				model: { provider: "bedrock", model: "x" },
				inProgress: other,
				capacity,
			}),
		).toBeNull();
		expect(
			findProviderCapacityHold({
				taskId: "me",
				model: lemonade("glm"),
				inProgress: [{ taskId: "other", model: lemonade("qwen") }],
				capacity: { lemonade: { maxLoadedModels: 2 } },
			}),
		).toBeNull();
		expect(findProviderCapacityHold({ taskId: "me", model: null, inProgress: other, capacity })).toBeNull();
	});
});
