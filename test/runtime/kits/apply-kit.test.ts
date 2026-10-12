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
			// Any model may be on any role: the team kit's defaults apply without a vetting check.
			const result = await applyWorkspaceKit({ workspaceId: "foo", kitName: "team-cloud" });
			expect(result.written).toBe(true);
			expect(result.kitName).toEqual({ from: "default", to: "team-cloud" });
			expect(result.landing).toEqual({ from: "off", to: "off" });
			expect(result.recommendedLandingMode).toBe("qa");
			expect(result.changes.find((change) => change.key === "qa.enabled")).toMatchObject({
				from: false,
				to: true,
				toSource: "team-cloud",
			});
			const config = readConfig(globalConfigPath);
			expect(config.selectedAgentId).toBe("claude");
			expect(config.processes).toEqual({ reaper: { mode: "report" } });
			expect(config.workspaces).toEqual({
				foo: {
					landing: { mode: "off" },
					kit: { name: "team-cloud", overrides: { "qa.blurb": "Project: Pawsome" } },
				},
				other: { landing: { mode: "commit" } },
			});
		});
	});

	it("sets the landing mode only with --landing, and edits overrides", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: {
					foo: { kit: { name: "team-cloud", overrides: { "qa.blurb": "x" } } },
				},
			});
			await applyWorkspaceKit({
				workspaceId: "foo",
				kitName: "team-cloud",
				landing: "qa",
				set: { "qa.promptNotes.dbSetup": "npx prisma migrate deploy" },
				unset: ["qa.blurb"],
			});
			expect(readConfig(globalConfigPath).workspaces).toEqual({
				foo: {
					landing: { mode: "qa" },
					kit: { name: "team-cloud", overrides: { "qa.promptNotes.dbSetup": "npx prisma migrate deploy" } },
				},
			});
		});
	});

	it("refuses an unknown override key, an unknown kit or an empty tier before writing", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			const original = { workspaces: { foo: { landing: { mode: "off" } } } };
			writeConfig(globalConfigPath, original);
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team-cloud", set: { "qa.blurbz": "x" } }),
			).rejects.toThrow(/blurbz/u);
			await expect(applyWorkspaceKit({ workspaceId: "foo", kitName: "nope" })).rejects.toThrow(/unknown kit/u);
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team-cloud", set: { "roles.dev.tier": "tier1" } }),
			).rejects.toThrow(/tier1/u);
			// --set takes only project settings: legacy keys and the team definition are refused.
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team-cloud", set: { "dev.agent": "codex" } }),
			).rejects.toThrow(/legacy key; use roles\.dev\.agent/u);
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team-cloud", set: { "onFail.reworkRounds": 5 } }),
			).rejects.toThrow(/part of the team definition/u);
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team-cloud", unset: ["qa.blurb"] }),
			).rejects.toThrow(/no override/u);
			expect(readConfig(globalConfigPath)).toEqual(original);
		});
	});

	it("answers kit apply team with the new name and writes nothing", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			const original = { workspaces: { foo: { landing: { mode: "qa" } } } };
			writeConfig(globalConfigPath, original);
			await expect(applyWorkspaceKit({ workspaceId: "foo", kitName: "team" })).rejects.toThrow(
				'kit "team" was renamed to team-cloud (2026-10-12); use team-cloud',
			);
			expect(readConfig(globalConfigPath)).toEqual(original);
		});
	});

	it("writes nothing on a dry run, and drops the kit entry for default without overrides", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team-cloud" } } },
			});
			const dryRun = await applyWorkspaceKit({ workspaceId: "foo", kitName: "default", dryRun: true });
			expect(dryRun.written).toBe(false);
			expect(readConfig(globalConfigPath).workspaces).toEqual({
				foo: { landing: { mode: "qa" }, kit: { name: "team-cloud" } },
			});
			await applyWorkspaceKit({ workspaceId: "foo", kitName: "default" });
			expect(readConfig(globalConfigPath).workspaces).toEqual({
				foo: { landing: { mode: "qa" } },
			});
		});
	});
});

describe("applyWorkspaceKit: switching kits", () => {
	it("keeps the project settings that fit the new kit, drops and reports the others, keeps old team keys", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: {
					foo: {
						kit: {
							name: "team-cloud",
							overrides: {
								"qa.blurb": "Foo",
								"roles.dev.model": "m-dev",
								"roles.dev.tier": "tier3",
								"qa.routes.0.model": "m-route",
								"tiers.qa.1.model": "m-qa",
								"fallback.on.conflict": false,
							},
						},
					},
				},
			});
			const dryRun = await applyWorkspaceKit({ workspaceId: "foo", kitName: "team-local", dryRun: true });
			expect(dryRun.written).toBe(false);
			expect(dryRun.dropped.map(({ key }) => key).sort()).toEqual([
				"qa.routes.0.model",
				"roles.dev.tier",
				"tiers.qa.1.model",
			]);
			expect(dryRun.dropped.find(({ key }) => key === "roles.dev.tier")?.why).toContain('tier "tier3"');
			expect(dryRun.dropped.find(({ key }) => key === "tiers.qa.1.model")?.why).toContain("no entry 1");
			expect(dryRun.dropped.find(({ key }) => key === "qa.routes.0.model")?.why).toContain(
				"qa.routes has no entry 0",
			);

			await applyWorkspaceKit({ workspaceId: "foo", kitName: "team-local" });
			expect((readConfig(globalConfigPath).workspaces as Record<string, { kit: unknown }>).foo.kit).toEqual({
				name: "team-local",
				overrides: { "qa.blurb": "Foo", "roles.dev.model": "m-dev", "fallback.on.conflict": false },
			});
		});
	});

	it("refuses the orchestrator a landing change and the removal of a stored team key", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			const original = {
				workspaces: {
					foo: { kit: { name: "team-cloud", overrides: { "qa.blurb": "Foo", "fallback.on.conflict": false } } },
				},
			};
			writeConfig(globalConfigPath, original);
			const by = { kind: "orchestrator", taskId: "__home_agent__:foo:claude" } as const;
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team-local", landing: "qa", by }),
			).rejects.toThrow(/landing mode is the user's/u);
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team-cloud", unset: ["fallback.on.conflict"], by }),
			).rejects.toThrow(/removing a stored team key is the user's/u);
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team-local", set: { "onFail.reworkRounds": 1 }, by }),
			).rejects.toThrow(/part of the team definition/u);
			expect(readConfig(globalConfigPath)).toEqual(original);
			const applied = await applyWorkspaceKit({
				workspaceId: "foo",
				kitName: "team-cloud",
				unset: ["qa.blurb"],
				by,
			});
			expect(applied.overrides).toEqual({ "fallback.on.conflict": false });
		});
	});
});
