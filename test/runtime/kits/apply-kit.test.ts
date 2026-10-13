import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { applyWorkspaceKit } from "../../../src/kits/apply-kit";
import { readKitSettingsHistory } from "../../../src/kits/project-settings";
import { getKanbanKitsPath, getKitSettingsHistoryPath } from "../../../src/state/kanban-home";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { readLegacyTeamKitText } from "../../utilities/team-kits";

function writeConfig(path: string, config: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
}

/** A full kit with tiers and a QA route (the built-in team-cloud kit before presets), as a user kit. */
function writeLegacyTeamKit(): void {
	mkdirSync(getKanbanKitsPath(), { recursive: true });
	writeFileSync(`${getKanbanKitsPath()}/legacy-team.json`, readLegacyTeamKitText());
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
			const result = await applyWorkspaceKit({ workspaceId: "foo", kitName: "team", preset: "cloud" });
			expect(result.written).toBe(true);
			expect(result.kitName).toEqual({ from: "default", to: "team" });
			expect(result.preset).toEqual({ from: null, to: "cloud" });
			expect(result.landing).toEqual({ from: "off", to: "off" });
			expect(result.recommendedLandingMode).toBe("qa");
			expect(result.changes.find((change) => change.key === "qa.enabled")).toMatchObject({
				from: false,
				to: true,
				toSource: "team",
			});
			expect(result.changes.find((change) => change.key === "roles.dev.model")).toMatchObject({
				to: "us.openai.gpt-6.1-sol",
				toSource: "preset:cloud",
			});
			const config = readConfig(globalConfigPath);
			expect(config.selectedAgentId).toBe("claude");
			expect(config.processes).toEqual({ reaper: { mode: "report" } });
			expect(config.workspaces).toEqual({
				foo: {
					landing: { mode: "off" },
					kit: { name: "team", preset: "cloud", overrides: { "qa.blurb": "Project: Pawsome" } },
				},
				other: { landing: { mode: "commit" } },
			});
		});
	});

	it("sets the landing mode only with --landing, and edits overrides", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: {
					// A stored old name reads as team + its preset, and the write stores the new pair.
					foo: { kit: { name: "team-local", overrides: { "qa.blurb": "x" } } },
				},
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
					kit: {
						name: "team",
						preset: "lemonade",
						overrides: { "qa.promptNotes.dbSetup": "npx prisma migrate deploy" },
					},
				},
			});
		});
	});

	it("refuses an unknown override key, an unknown kit or an empty tier before writing", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			const original = { workspaces: { foo: { landing: { mode: "off" } } } };
			writeConfig(globalConfigPath, original);
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team", preset: "lemonade", set: { "qa.blurbz": "x" } }),
			).rejects.toThrow(/blurbz/u);
			await expect(applyWorkspaceKit({ workspaceId: "foo", kitName: "nope" })).rejects.toThrow(/unknown kit/u);
			await expect(
				applyWorkspaceKit({
					workspaceId: "foo",
					kitName: "team",
					preset: "lemonade",
					set: { "roles.dev.tier": "tier1" },
				}),
			).rejects.toThrow(/tier1/u);
			await expect(applyWorkspaceKit({ workspaceId: "foo", kitName: "team", preset: "nope" })).rejects.toThrow(
				/unknown preset "nope"/u,
			);
			await expect(applyWorkspaceKit({ workspaceId: "foo", kitName: "default", preset: "cloud" })).rejects.toThrow(
				/has no presets/u,
			);
			// --set takes only project settings: legacy keys and the team definition are refused.
			await expect(
				applyWorkspaceKit({
					workspaceId: "foo",
					kitName: "team",
					preset: "lemonade",
					set: { "dev.agent": "codex" },
				}),
			).rejects.toThrow(/legacy key; use roles\.dev\.agent/u);
			await expect(
				applyWorkspaceKit({
					workspaceId: "foo",
					kitName: "team",
					preset: "lemonade",
					set: { "onFail.reworkRounds": 5 },
				}),
			).rejects.toThrow(/part of the team definition/u);
			await expect(
				applyWorkspaceKit({ workspaceId: "foo", kitName: "team", preset: "lemonade", unset: ["qa.blurb"] }),
			).rejects.toThrow(/no override/u);
			expect(readConfig(globalConfigPath)).toEqual(original);
		});
	});

	it("answers a renamed kit with the team kit and preset, and asks the team kit for its models; writes nothing", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			const original = { workspaces: { foo: { landing: { mode: "qa" } } } };
			writeConfig(globalConfigPath, original);
			await expect(applyWorkspaceKit({ workspaceId: "foo", kitName: "team-cloud" })).rejects.toThrow(
				'kit "team-cloud" is now team (cloud) (2026-10-12); use team --preset cloud',
			);
			await expect(applyWorkspaceKit({ workspaceId: "foo", kitName: "team" })).rejects.toThrow(
				/needs its models: a preset .* or a custom team/u,
			);
			expect(readConfig(globalConfigPath)).toEqual(original);
		});
	});

	it("a custom team takes the workflow from the team kit and needs its dev and QA agents", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			const original = { workspaces: { foo: { landing: { mode: "qa" } } } };
			writeConfig(globalConfigPath, original);
			await expect(
				applyWorkspaceKit({
					workspaceId: "foo",
					kitName: "team",
					preset: null,
					set: { "roles.dev.agent": "codex" },
				}),
			).rejects.toThrow(/a custom team .* needs roles.qa.agent/u);
			// The workflow stays the team kit's: a custom team can't change a flow key either.
			await expect(
				applyWorkspaceKit({
					workspaceId: "foo",
					kitName: "team",
					preset: null,
					set: { "roles.dev.agent": "codex", "roles.qa.agent": "cline", "fallback.requireApproval": true },
				}),
			).rejects.toThrow(/part of the team definition/u);
			expect(readConfig(globalConfigPath)).toEqual(original);
			const applied = await applyWorkspaceKit({
				workspaceId: "foo",
				kitName: "team",
				preset: null,
				set: {
					"roles.dev.agent": "codex",
					"roles.dev.model": "us.openai.gpt-6.1-sol",
					"roles.qa.agent": "cline",
					"roles.qa.provider": "lemonade",
					"roles.qa.model": "gemma-4-31B-it-qat-q4_0-gguf-Q4_0",
				},
			});
			expect(applied.preset).toEqual({ from: null, to: null });
			expect((readConfig(globalConfigPath).workspaces as Record<string, { kit: unknown }>).foo.kit).toEqual({
				name: "team",
				preset: null,
				overrides: {
					"roles.dev.agent": "codex",
					"roles.dev.model": "us.openai.gpt-6.1-sol",
					"roles.qa.agent": "cline",
					"roles.qa.provider": "lemonade",
					"roles.qa.model": "gemma-4-31B-it-qat-q4_0-gguf-Q4_0",
				},
			});
			// A later kit apply on the same kit keeps the custom team (no --preset/--custom needed).
			const again = await applyWorkspaceKit({ workspaceId: "foo", kitName: "team", set: { "qa.blurb": "Foo" } });
			expect(again.preset).toEqual({ from: null, to: null });
		});
	});

	it("writes nothing on a dry run, and drops the kit entry for default without overrides", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team", preset: "cloud" } } },
			});
			const dryRun = await applyWorkspaceKit({ workspaceId: "foo", kitName: "default", dryRun: true });
			expect(dryRun.written).toBe(false);
			expect(readConfig(globalConfigPath).workspaces).toEqual({
				foo: { landing: { mode: "qa" }, kit: { name: "team", preset: "cloud" } },
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
			writeLegacyTeamKit();
			writeConfig(globalConfigPath, {
				workspaces: {
					foo: {
						kit: {
							name: "legacy-team",
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
			const dryRun = await applyWorkspaceKit({
				workspaceId: "foo",
				kitName: "team",
				preset: "lemonade",
				dryRun: true,
			});
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

			await applyWorkspaceKit({ workspaceId: "foo", kitName: "team", preset: "lemonade" });
			expect((readConfig(globalConfigPath).workspaces as Record<string, { kit: unknown }>).foo.kit).toEqual({
				name: "team",
				preset: "lemonade",
				overrides: { "qa.blurb": "Foo", "roles.dev.model": "m-dev", "fallback.on.conflict": false },
			});
		});
	});

	it("keeps a role's provider beside the project's own model for that role (issue #40)", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeLegacyTeamKit();
			writeConfig(globalConfigPath, {
				workspaces: {
					foo: {
						kit: {
							name: "legacy-team",
							overrides: {
								"roles.dev.agent": "codex",
								"roles.qa.provider": "bedrock",
								"roles.qa.model": "us.anthropic.claude-haiku-5-5",
								"roles.qa.agent": "cline",
								"roles.plan.provider": "bedrock",
							},
						},
					},
				},
			});
			const dryRun = await applyWorkspaceKit({
				workspaceId: "foo",
				kitName: "team",
				preset: null,
				dryRun: true,
			});
			expect(dryRun.dropped).toEqual([
				{ key: "roles.plan.provider", value: "bedrock", why: expect.stringContaining("needs roles.plan.model") },
			]);
			expect(dryRun.overrides).toMatchObject({
				"roles.qa.provider": "bedrock",
				"roles.qa.model": "us.anthropic.claude-haiku-5-5",
				"roles.qa.agent": "cline",
			});

			const withSet = await applyWorkspaceKit({
				workspaceId: "foo",
				kitName: "team",
				preset: null,
				set: { "roles.plan.agent": "cline", "roles.plan.model": "us.anthropic.claude-opus-5-5" },
			});
			expect(withSet.dropped).toEqual([]);
			expect((readConfig(globalConfigPath).workspaces as Record<string, { kit: unknown }>).foo.kit).toEqual({
				name: "team",
				preset: null,
				overrides: {
					"roles.dev.agent": "codex",
					"roles.qa.provider": "bedrock",
					"roles.qa.model": "us.anthropic.claude-haiku-5-5",
					"roles.qa.agent": "cline",
					"roles.plan.provider": "bedrock",
					"roles.plan.agent": "cline",
					"roles.plan.model": "us.anthropic.claude-opus-5-5",
				},
			});
		});
	});

	it("lets the orchestrator set its project's landing mode and logs who changed it", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: { foo: { landing: { mode: "off" }, kit: { name: "team", preset: "cloud" } } },
			});
			const by = { kind: "orchestrator", taskId: "__home_agent__:foo:claude" } as const;
			const dryRun = await applyWorkspaceKit({
				workspaceId: "foo",
				kitName: "team",
				landing: "qa",
				by,
				dryRun: true,
			});
			expect(dryRun).toMatchObject({ landing: { from: "off", to: "qa" }, written: false });
			expect(readConfig(globalConfigPath).workspaces).toEqual({
				foo: { landing: { mode: "off" }, kit: { name: "team", preset: "cloud" } },
			});

			const applied = await applyWorkspaceKit({ workspaceId: "foo", kitName: "team", landing: "qa", by });
			expect(applied).toMatchObject({ landing: { from: "off", to: "qa" }, written: true });
			expect(readConfig(globalConfigPath).workspaces).toEqual({
				foo: { landing: { mode: "qa" }, kit: { name: "team", preset: "cloud", overrides: {} } },
			});
			// The same mode again changes nothing and logs nothing.
			await applyWorkspaceKit({ workspaceId: "foo", kitName: "team", landing: "qa", by });
			const history = await readKitSettingsHistory(getKitSettingsHistoryPath("foo"));
			expect(history).toEqual([
				{
					at: expect.any(String),
					workspaceId: "foo",
					kitName: "team",
					key: "(landing)",
					from: "off",
					to: "qa",
					by,
					via: "kit apply",
				},
			]);
		});
	});

	it("refuses the orchestrator the removal of a stored team key", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			const original = {
				workspaces: {
					foo: {
						kit: {
							name: "team",
							preset: "cloud",
							overrides: { "qa.blurb": "Foo", "fallback.on.conflict": false },
						},
					},
				},
			};
			writeConfig(globalConfigPath, original);
			const by = { kind: "orchestrator", taskId: "__home_agent__:foo:claude" } as const;
			await expect(
				applyWorkspaceKit({
					workspaceId: "foo",
					kitName: "team",
					preset: "lemonade",
					unset: ["fallback.on.conflict"],
					by,
				}),
			).rejects.toThrow(/removing a stored team key is the user's/u);
			await expect(
				applyWorkspaceKit({
					workspaceId: "foo",
					kitName: "team",
					preset: "lemonade",
					set: { "onFail.reworkRounds": 1 },
					by,
				}),
			).rejects.toThrow(/part of the team definition/u);
			expect(readConfig(globalConfigPath)).toEqual(original);
			const applied = await applyWorkspaceKit({
				workspaceId: "foo",
				kitName: "team",
				unset: ["qa.blurb"],
				by,
			});
			expect(applied.overrides).toEqual({ "fallback.on.conflict": false });
		});
	});
});
