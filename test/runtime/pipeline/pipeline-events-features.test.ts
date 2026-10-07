import { describe, expect, it, vi } from "vitest";

import { getBuiltInKits, getDefaultKit } from "../../../src/kits/resolve-kit";
import { createPipelineEventBus, type PipelineEventMap } from "../../../src/pipeline/events";
import { createPipelineFeatureRegistry } from "../../../src/pipeline/features";

function landedEvent(workspaceId: string): PipelineEventMap["landed"] {
	return { workspaceId, taskId: "dev-1", at: 1, baseRef: "main", commit: "abc", via: "qa" };
}

function teamKit() {
	const kit = getBuiltInKits().get("team");
	if (!kit) {
		throw new Error("team kit missing");
	}
	return kit;
}

describe("pipeline event bus", () => {
	it("runs every handler, isolates a failing one, and stops after unsubscribe", async () => {
		const log = vi.fn();
		const bus = createPipelineEventBus({ log });
		const good = vi.fn();
		const unsubscribe = bus.on("landed", good);
		bus.on("landed", () => {
			throw new Error("boom");
		});
		bus.on("landed", async () => {
			await Promise.reject(new Error("async boom"));
		});

		await bus.emit("landed", landedEvent("foo"));
		expect(good).toHaveBeenCalledWith(landedEvent("foo"));
		expect(log).toHaveBeenCalledTimes(2);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));

		unsubscribe();
		await bus.emit("landed", landedEvent("foo"));
		expect(good).toHaveBeenCalledTimes(1);
	});
});

describe("pipeline feature registry", () => {
	it("runs a feature only for workspaces whose kit lists it, on that workspace's events only", async () => {
		const bus = createPipelineEventBus();
		const registry = createPipelineFeatureRegistry({ bus });
		const seen: string[] = [];
		const stop = vi.fn();
		registry.register({
			name: "scoreboard",
			activate: (context) => {
				context.on("landed", (event) => {
					seen.push(`${context.workspaceId}:${event.workspaceId}`);
				});
				return stop;
			},
		});

		expect(registry.syncWorkspace("foo", teamKit()).active).toEqual(["scoreboard"]);
		expect(registry.syncWorkspace("kanban-2uge", getDefaultKit()).active).toEqual([]);
		await bus.emit("landed", landedEvent("foo"));
		await bus.emit("landed", landedEvent("kanban-2uge"));
		expect(seen).toEqual(["foo:foo"]);

		// The workspace moves to the default kit: the feature stops and hears nothing more.
		registry.syncWorkspace("foo", getDefaultKit());
		expect(stop).toHaveBeenCalledTimes(1);
		await bus.emit("landed", landedEvent("foo"));
		expect(seen).toEqual(["foo:foo"]);
	});

	it("lists an active feature's jobs for the watchdog's job runner, and drops them when it stops", async () => {
		const registry = createPipelineFeatureRegistry({ bus: createPipelineEventBus() });
		const run = vi.fn(async () => "checked");
		registry.register({
			name: "bench",
			activate: (context) => {
				context.job({ name: "price-check", everyMin: 1440, run });
				return undefined;
			},
		});
		registry.syncWorkspace("foo", teamKit());
		const jobs = registry.listJobs("foo");
		expect(jobs.map((job) => [job.name, job.everyMin])).toEqual([["bench:price-check", 1440]]);
		await expect(jobs[0]?.run()).resolves.toBe("checked");
		expect(registry.listJobs("kanban-2uge")).toEqual([]);
		registry.syncWorkspace("foo", getDefaultKit());
		expect(registry.listJobs("foo")).toEqual([]);
	});

	it("reports a listed feature nobody registered once, and restarts a feature when the kit changes", () => {
		const log = vi.fn();
		const registry = createPipelineFeatureRegistry({ bus: createPipelineEventBus(), log });
		const activate = vi.fn(() => undefined);
		registry.register({ name: "bench", activate });

		const first = registry.syncWorkspace("foo", teamKit());
		expect(first.active).toEqual(["bench"]);
		expect(first.unavailable).toEqual(["scoreboard", "runoffs", "calibration", "tiers"]);
		registry.syncWorkspace("foo", teamKit());
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("scoreboard, runoffs, calibration, tiers"));
		expect(activate).toHaveBeenCalledTimes(1);

		registry.syncWorkspace("foo", { ...teamKit(), description: "changed" });
		expect(activate).toHaveBeenCalledTimes(2);
		expect(() => registry.register({ name: "bench", activate })).toThrow(/already registered/u);
		registry.close();
	});
});
