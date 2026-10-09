import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { migrateWorkspaceOverrides } from "../../../src/kits/migrate-overrides";
import { readKitSettingsHistory } from "../../../src/kits/project-settings";
import { loadKitCatalog, resolveKitByName, resolveWorkspaceKit } from "../../../src/kits/resolve-kit";
import { createUserKit, editUserKit, readKitHistory } from "../../../src/kits/user-kit-edit";
import {
	getKanbanKitsPath,
	getKitBackupsPath,
	getKitHistoryPath,
	getKitSettingsHistoryPath,
} from "../../../src/state/kanban-home";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

const FOO_OVERRIDES = JSON.parse(
	readFileSync(join(import.meta.dirname, "fixtures", "foo-overrides-2026-10-09.json"), "utf8"),
) as Record<string, unknown>;

function writeConfig(path: string, config: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
}

function readKitFile(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(getKanbanKitsPath(), `${name}.json`), "utf8")) as Record<string, unknown>;
}

describe("kanban kit create", () => {
	it("writes a complete copy of the --from kit with the --set keys, and logs it", async () => {
		await withTemporaryKanbanHome(async () => {
			const result = await createUserKit({
				name: "team-quiet",
				from: "team",
				set: { "fallback.on.conflict": false, "onFail.reworkRounds": 2 },
				description: "team without the conflict fallback",
			});
			expect(result.written).toBe(true);
			expect(result.changes).toEqual([
				{ key: "description", from: expect.any(String), to: "team without the conflict fallback" },
				{ key: "fallback.on.conflict", from: true, to: false },
				{ key: "onFail.reworkRounds", from: 3, to: 2 },
			]);
			const catalog = await loadKitCatalog();
			expect(catalog.errors).toEqual([]);
			const team = resolveKitByName(catalog, "team");
			const copy = resolveKitByName(catalog, "team-quiet");
			if (!team.ok || !copy.ok) {
				throw new Error("does not resolve");
			}
			// Complete: the file alone is the kit, every source is the kit itself, not default.
			expect(readKitFile("team-quiet")).toEqual({ ...copy.kit });
			expect(copy.kit.roles).toEqual(team.kit.roles);
			expect(copy.kit.qa).toEqual(team.kit.qa);
			expect(copy.kit.fallback?.on).toMatchObject({ qaFails: true, conflict: false });

			const history = await readKitHistory(getKitHistoryPath());
			expect(history.map((entry) => [entry.via, entry.key])).toEqual([
				["kit create", "(kit)"],
				["kit create", "description"],
				["kit create", "fallback.on.conflict"],
				["kit create", "onFail.reworkRounds"],
			]);
			expect(history[0]).toMatchObject({
				kitName: "team-quiet",
				to: "created from team",
				by: { kind: "user-command" },
			});
		});
	});

	it("writes nothing on a dry run", async () => {
		await withTemporaryKanbanHome(async () => {
			const result = await createUserKit({ name: "copy", from: "team-local", dryRun: true });
			expect(result.written).toBe(false);
			expect(existsSync(join(getKanbanKitsPath(), "copy.json"))).toBe(false);
			expect(existsSync(getKitHistoryPath())).toBe(false);
		});
	});

	it("refuses taken names, bad keys and values that don't validate", async () => {
		await withTemporaryKanbanHome(async () => {
			await createUserKit({ name: "mine", from: "team" });
			for (const name of ["default", "team", "team-local", "mine"]) {
				await expect(createUserKit({ name, from: "team" })).rejects.toThrow(/built-in kit|already exists/);
			}
			await expect(createUserKit({ name: "Bad Name", from: "team" })).rejects.toThrow("not a kit name");
			await expect(createUserKit({ name: "x", from: "nope" })).rejects.toThrow('unknown kit "nope"');
			const refusedSets: Array<[Record<string, unknown>, string]> = [
				[{ "nope.x": 1 }, "is not a kit key"],
				[{ name: "other" }, "identifies the kit"],
				[{ "escalate.to": "orchestrator" }, "legacy key"],
				[{ "qa.blurb": "Project: x" }, "project fact"],
				[{ "fallback.on.qaStalled": "maybe" }, "does not resolve"],
				[{ "onFail.reworkRounds": -1 }, "does not resolve"],
			];
			for (const [set, message] of refusedSets) {
				await expect(createUserKit({ name: "x", from: "team", set })).rejects.toThrow(message);
			}
			expect(existsSync(join(getKanbanKitsPath(), "x.json"))).toBe(false);
		});
	});
});

describe("kanban kit edit", () => {
	it("changes a user kit, backs it up, lists the workspaces on it and logs old -> new", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: {
					alpha: { kit: { name: "mine", overrides: { "fallback.on.unchanged": true } } },
					beta: { kit: { name: "team", overrides: {} } },
				},
			});
			await createUserKit({ name: "mine", from: "team" });
			const original = readFileSync(join(getKanbanKitsPath(), "mine.json"), "utf8");

			const dry = await editUserKit({ name: "mine", set: { "fallback.on.unchanged": false }, dryRun: true });
			expect(dry.written).toBe(false);
			expect(readFileSync(join(getKanbanKitsPath(), "mine.json"), "utf8")).toBe(original);

			const result = await editUserKit({
				name: "mine",
				set: { "fallback.on.unchanged": false, "fallback.requireApproval": true },
				unset: ["plan.note"],
			});
			expect(result.written).toBe(true);
			expect(result.changes).toEqual([
				{ key: "fallback.on.unchanged", from: true, to: false },
				{ key: "fallback.requireApproval", from: false, to: true },
				{ key: "plan.note", from: expect.any(String) },
			]);
			// alpha is on the kit, and its own (pre-split) override still wins for the trigger.
			expect(result.workspaces).toEqual([{ workspaceId: "alpha", shadowedBy: ["fallback.on.unchanged"] }]);
			expect(readKitFile("mine")).toMatchObject({ fallback: { on: { unchanged: false }, requireApproval: true } });
			expect((readKitFile("mine").plan as Record<string, unknown>).note).toBeUndefined();

			expect(readdirSync(getKitBackupsPath())).toHaveLength(1);
			expect(result.backupPath && readFileSync(result.backupPath, "utf8")).toBe(original);

			const history = (await readKitHistory(getKitHistoryPath())).filter((entry) => entry.via === "kit edit");
			expect(history.map((entry) => [entry.key, entry.from, entry.to])).toEqual([
				["fallback.on.unchanged", true, false],
				["fallback.requireApproval", false, true],
				["plan.note", expect.any(String), undefined],
			]);
			const alphaHistory = await readKitSettingsHistory(getKitSettingsHistoryPath("alpha"));
			expect(alphaHistory.map((entry) => [entry.via, entry.kitName, entry.key])).toEqual([
				["kit edit", "mine", "fallback.on.unchanged"],
				["kit edit", "mine", "fallback.requireApproval"],
				["kit edit", "mine", "plan.note"],
			]);
			expect(existsSync(getKitSettingsHistoryPath("beta"))).toBe(false);
		});
	});

	it("refuses built-in kits, unknown kits, bad keys and invalid results, and leaves the file alone", async () => {
		await withTemporaryKanbanHome(async () => {
			await createUserKit({ name: "mine", from: "team" });
			const original = readFileSync(join(getKanbanKitsPath(), "mine.json"), "utf8");
			for (const name of ["default", "team", "team-local"]) {
				await expect(editUserKit({ name, set: { "qa.enabled": false } })).rejects.toThrow("built-in kit");
			}
			await expect(editUserKit({ name: "nope", set: { "qa.enabled": false } })).rejects.toThrow("unknown kit");
			await expect(editUserKit({ name: "mine" })).rejects.toThrow("nothing to change");
			await expect(editUserKit({ name: "mine", set: { "land.postLand": [] } })).rejects.toThrow("project fact");
			await expect(editUserKit({ name: "mine", set: { "onOutage.then": "escalate" } })).rejects.toThrow(
				"legacy key",
			);
			await expect(editUserKit({ name: "mine", unset: ["fallback.on.nope"] })).rejects.toThrow("has no");
			// Triggers that fire need a fallback role.
			await expect(editUserKit({ name: "mine", unset: ["roles.fallback"] })).rejects.toThrow(
				"has no roles.fallback",
			);
			expect(readFileSync(join(getKanbanKitsPath(), "mine.json"), "utf8")).toBe(original);
			expect(existsSync(getKitBackupsPath())).toBe(false);
		});
	});

	it("foo's case: migrate-overrides --into team-foo, then the three triggers off", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: {
					foo: { landing: { mode: "qa" }, kit: { name: "team", overrides: structuredClone(FOO_OVERRIDES) } },
				},
			});
			const migrated = await migrateWorkspaceOverrides({ workspaceId: "foo", into: "team-foo" });
			expect(migrated.toKit).toBe("team-foo");
			const configAfterMigration = parsePipelineConfig(JSON.parse(readFileSync(globalConfigPath, "utf8"))).config;
			const before = resolveWorkspaceKit(configAfterMigration, "foo", await loadKitCatalog());

			const result = await editUserKit({
				name: "team-foo",
				set: { "fallback.on.qaStalled": false, "fallback.on.conflict": false, "fallback.on.unchanged": false },
			});
			expect(result.workspaces).toEqual([{ workspaceId: "foo", shadowedBy: [] }]);

			const after = resolveWorkspaceKit(configAfterMigration, "foo", await loadKitCatalog());
			expect(after.issues).toEqual([]);
			expect(after.kitName).toBe("team-foo");
			expect(after.kit.fallback?.on).toEqual({
				qaFails: true,
				qaStalled: false,
				unchanged: false,
				conflict: false,
				outage: true,
			});
			// Everything else as foo had it.
			const { fallback: fallbackAfter, ...restAfter } = after.kit;
			const { fallback: fallbackBefore, ...restBefore } = before.kit;
			expect(restAfter).toEqual(restBefore);
			expect({ ...fallbackAfter, on: undefined }).toEqual({ ...fallbackBefore, on: undefined });
		});
	});
});
