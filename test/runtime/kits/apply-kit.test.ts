import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { applyWorkspaceKit } from "../../../src/kits/apply-kit";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

function writeConfig(path: string, config: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
}

function readConfig(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("applyWorkspaceKit", () => {
	it("writes the kit name, keeps overrides and every other config key, and leaves landing alone", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				selectedAgentId: "claude",
				processes: { reaper: { mode: "report" } },
				workspaces: {
					foo: {
						landing: { mode: "off" },
						kit: { name: "default", overrides: { "qa.blurb": "Project: Pawsome" } },
					},
					other: { landing: { mode: "commit" } },
				},
			});
			const result = await applyWorkspaceKit({ workspaceId: "foo", kitName: "team" });
			expect(result.written).toBe(true);
			expect(result.kitName).toEqual({ from: "default", to: "team" });
			expect(result.landing).toEqual({ from: "off", to: "off" });
			expect(result.recommendedLandingMode).toBe("qa");
			expect(result.changes.find((change) => change.key === "qa.enabled")).toMatchObject({
				from: false,
				to: true,
				toSource: "team",
			});
			const config = readConfig(globalConfigPath);
			expect(config.selectedAgentId).toBe("claude");
			expect(config.processes).toEqual({ reaper: { mode: "report" } });
			expect(config.workspaces).toEqual({
				foo: { landing: { mode: "off" }, kit: { name: "team", overrides: { "qa.blurb": "Project: Pawsome" } } },
				other: { landing: { mode: "commit" } },
			});
		});
	});

	it("sets the landing mode only with --landing, and edits overrides", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: { foo: { kit: { name: "team", overrides: { "qa.blurb": "x" } } } },
			});
			await applyWorkspaceKit({
				workspaceId: "foo",
				kitName: "team",
				landing: "qa",
				set: { "qa.promptNotes.dbSetup": "npx prisma migrate deploy" },
				unset: ["qa.blurb"],
			});
			expect(readConfig(globalConfigPath).workspaces).toEqual({
				foo: {
					landing: { mode: "qa" },
					kit: { name: "team", overrides: { "qa.promptNotes.dbSetup": "npx prisma migrate deploy" } },
				},
			});
		});
	});

	it("refuses an unknown override key, an unknown kit or an empty tier before writing", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			const original = { workspaces: { foo: { landing: { mode: "off" } } } };
			writeConfig(globalConfigPath, original);
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team", set: { "qa.blurbz": "x" } }),
			).rejects.toThrow(/blurbz/u);
			await expect(applyWorkspaceKit({ workspaceId: "foo", kitName: "nope" })).rejects.toThrow(/unknown kit/u);
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team", set: { "roles.dev.tier": "tier1" } }),
			).rejects.toThrow(/tier1/u);
			// --set takes only project settings: legacy keys and the team definition are refused.
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team", set: { "dev.agent": "codex" } }),
			).rejects.toThrow(/legacy key; use roles\.dev\.agent/u);
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team", set: { "onFail.reworkRounds": 5 } }),
			).rejects.toThrow(/part of the team definition/u);
			await expect(applyWorkspaceKit({ workspaceId: "foo", kitName: "team", unset: ["qa.blurb"] })).rejects.toThrow(
				/no override/u,
			);
			expect(readConfig(globalConfigPath)).toEqual(original);
		});
	});

	it("writes nothing on a dry run, and drops the kit entry for default without overrides", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, { workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" } } } });
			const dryRun = await applyWorkspaceKit({ workspaceId: "foo", kitName: "default", dryRun: true });
			expect(dryRun.written).toBe(false);
			expect(readConfig(globalConfigPath).workspaces).toEqual({
				foo: { landing: { mode: "qa" }, kit: { name: "team" } },
			});
			await applyWorkspaceKit({ workspaceId: "foo", kitName: "default" });
			expect(readConfig(globalConfigPath).workspaces).toEqual({ foo: { landing: { mode: "qa" } } });
		});
	});
});
