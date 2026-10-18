import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { objectiveCreateSchema } from "../../../src/core/objective-contract";
import {
	checksObjectiveReceipt,
	createObjectiveEvidenceOwner,
	replayObjectiveReceipts,
	retainObjectiveReceipt,
} from "../../../src/objectives/objective-receipts";
import { createObjectiveStore } from "../../../src/objectives/objective-store";
import type { ChecksResult } from "../../../src/pipeline/checks";
import { createPipelineStateStore } from "../../../src/pipeline/pipeline-state";
import { getObjectivePaths } from "../../../src/state/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";

const T0 = Date.parse("2026-10-17T10:00:00Z");
function result(): ChecksResult {
	return {
		request: {
			workspaceId: "foo",
			taskId: "dev01",
			repoPath: "/fixture",
			title: "Regression",
			baseRef: "main",
			snapshot: "a".repeat(40),
			scripts: ["test", "lint"],
		},
		verdict: "PASS",
		harness: false,
		steps: [
			{ name: "install", ok: true },
			{ name: "test", ok: true },
		],
		logsDir: "/fixture/logs",
		startedAt: T0,
		finishedAt: T0 + 1000,
		timeoutMin: 10,
		error: null,
	};
}

describe("native owner receipts", () => {
	it("never binds historical checks after arrival; skipped/missing scripts remain unknown", async () => {
		const temp = createTempDir("objective-receipts-");
		try {
			const store = createObjectiveStore({ home: temp.path, now: () => new Date(T0) });
			const owner = createObjectiveEvidenceOwner(store);
			const run = result();
			expect(await owner.capture("foo", "dev01")).toBeNull();
			await store.create(
				"foo",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Tests pass",
					taskIds: ["dev01"],
				}),
			);
			expect(checksObjectiveReceipt(run)).toBeNull();
			const capture = await owner.capture("foo", "dev01");
			if (!capture) throw new Error("Missing capture");
			run.request.objectiveBinding = capture.binding;
			const receipt = checksObjectiveReceipt(run);
			expect(receipt).toMatchObject({
				kind: "checks",
				scripts: [
					{ name: "test", status: "pass", harness: false },
					{ name: "lint", status: "unknown", harness: false },
				],
			});
			run.harness = true;
			expect(checksObjectiveReceipt(run)).toMatchObject({
				scripts: [
					{ name: "test", status: "unknown", harness: true },
					{ name: "lint", status: "unknown", harness: true },
				],
			});
		} finally {
			temp.cleanup();
		}
	});
	it("replays a committed producer result after collection crashed, without rerunning checks or changing the receipt", async () => {
		const temp = createTempDir("objective-replay-");
		try {
			const store = createObjectiveStore({ home: temp.path, now: () => new Date(T0) });
			await store.create(
				"foo",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Tests pass",
					taskIds: ["dev01"],
				}),
			);
			const capture = await createObjectiveEvidenceOwner(store).capture("foo", "dev01");
			if (!capture) throw new Error("Missing capture");
			const run = result();
			run.request.objectiveBinding = capture.binding;
			const receipt = checksObjectiveReceipt(run);
			if (!receipt) throw new Error("No receipt");
			const pipeline = createPipelineStateStore({
				getStatePath: (id) => join(temp.path, "data", id, "pipeline-state.json"),
				getLegacyChecksStatePaths: () => [],
			});
			await pipeline.update("foo", (state) => {
				state.cards.dev01 = retainObjectiveReceipt(state.cards.dev01, receipt);
				return state;
			});
			const restarted = createObjectiveStore({ home: temp.path });
			await replayObjectiveReceipts(restarted, "foo", await pipeline.load("foo"));
			await replayObjectiveReceipts(restarted, "foo", await pipeline.load("foo"));
			expect((await restarted.read("foo")).objectives[0]?.evidence).toEqual([receipt]);
			expect(() =>
				retainObjectiveReceipt(retainObjectiveReceipt(undefined, receipt), {
					...receipt,
					at: "2026-10-17T11:00:00Z",
				}),
			).toThrow("conflicts");
		} finally {
			temp.cleanup();
		}
	});
	it("refuses damaged requirement objects before capture or collection, preserving the journal", async () => {
		const temp = createTempDir("objective-corrupt-receipt-");
		try {
			const store = createObjectiveStore({ home: temp.path });
			const owner = createObjectiveEvidenceOwner(store);
			const objective = await store.create(
				"foo",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Must pass",
					taskIds: ["dev01"],
				}),
			);
			const capture = await owner.capture("foo", "dev01");
			if (!capture) throw new Error("No capture");
			const run = result();
			run.request.objectiveBinding = capture.binding;
			const receipt = checksObjectiveReceipt(run);
			if (!receipt) throw new Error("No receipt");
			const paths = getObjectivePaths("foo", temp.path);
			const before = await readFile(paths.state, "utf8");
			await writeFile(join(paths.requirements, `${objective.requirementsHash}.md`), "tampered");
			await expect(owner.capture("foo", "dev01")).rejects.toThrow("unavailable or changed");
			await expect(owner.record("foo", receipt)).rejects.toThrow("unavailable or changed");
			expect(await readFile(paths.state, "utf8")).toBe(before);
		} finally {
			temp.cleanup();
		}
	});
});
