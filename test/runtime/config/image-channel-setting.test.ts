// `update.imageChannel` (the pod image tag `kanban restart update`, the restart wake and doctor compare with) and
// `kanban config set|unset update.imageChannel`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setImageChannel, unsetImageChannel } from "../../../src/config/image-channel-setting";
import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { getKanbanGlobalConfigPath } from "../../../src/state/kanban-home";
import { createRestartUpdateApi } from "../../../src/trpc/restart-update-api";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";

const BUILD = { revision: "aaaaaaa1111", created: "2026-10-11T06:20:00.000Z", version: null, digest: null };

describe("update.imageChannel", () => {
	it("defaults to latest, reads stable, and falls back to latest on an unknown channel", () => {
		expect(parsePipelineConfig({}).config.update.imageChannel).toBe("latest");
		expect(parsePipelineConfig({ update: { imageChannel: "stable" } }).config.update.imageChannel).toBe("stable");
		const bad = parsePipelineConfig({ update: { imageChannel: "nightly" } });
		expect(bad.config.update.imageChannel).toBe("latest");
		expect(bad.issues.join("\n")).toContain("update: imageChannel");
	});

	it("is the channel kanban restart update reads from config.json", async () => {
		await withTemporaryKanbanHome(async () => {
			await setImageChannel("stable", getKanbanGlobalConfigPath());
			const asked: string[] = [];
			const api = createRestartUpdateApi({
				log: async () => {},
				warn: () => {},
				listWorkspaces: async () => [],
				loadState: async () => {
					throw new Error("no workspaces");
				},
				requestExit: () => {},
				isInContainer: () => true,
				readRunningBuild: () => BUILD,
				fetchLatestBuild: async (channel) => {
					asked.push(channel);
					return { ...BUILD, digest: "sha256:x" };
				},
				appendLog: async () => {},
			});
			const response = await api.update({ kind: "user" }, { force: false, dryRun: true });
			expect(asked).toEqual(["stable"]);
			expect(response.lines).toContain("ghcr.io/vombor/kanban:stable: aaaaaaa (built 2026-10-11 06:20Z), sha256:x");
		});
	});
});

describe("kanban config set|unset update.imageChannel", () => {
	let dir: { path: string; cleanup: () => void };
	let configPath: string;

	beforeEach(() => {
		dir = createTempDir("kanban-config-channel-");
		configPath = join(dir.path, "config.json");
		writeFileSync(configPath, `${JSON.stringify({ other: { keep: true } })}\n`);
	});

	afterEach(() => {
		dir.cleanup();
	});

	const read = () => JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;

	it("sets stable, keeps every other key, and unset drops the section", async () => {
		const set = await setImageChannel("stable", configPath);
		expect(set).toMatchObject({ key: "update.imageChannel", from: undefined, to: "stable" });
		expect(set.next).toContain("ghcr.io/vombor/kanban:stable");
		expect(read()).toMatchObject({ update: { imageChannel: "stable" }, other: { keep: true } });

		const unset = await unsetImageChannel(configPath);
		expect(unset).toMatchObject({ from: "stable", to: null });
		expect(read().update).toBeUndefined();
		expect(read().other).toEqual({ keep: true });
	});

	it("refuses a channel that isn't latest or stable, writing nothing", async () => {
		await expect(setImageChannel("nightly", configPath)).rejects.toThrow(
			'update.imageChannel is one of latest, stable, not "nightly"',
		);
		expect(read()).toEqual({ other: { keep: true } });
	});
});
