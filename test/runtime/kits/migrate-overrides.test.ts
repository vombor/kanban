import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { checkKitProjectSettings } from "../../../src/doctor/kit-settings-checks";
import { migrateWorkspaceOverrides } from "../../../src/kits/migrate-overrides";
import { readKitSettingsHistory } from "../../../src/kits/project-settings";
import { loadKitCatalog, resolveWorkspaceKit } from "../../../src/kits/resolve-kit";
import { getKanbanKitsPath, getKitSettingsHistoryPath } from "../../../src/state/kanban-home";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

// foo's overrides as `kanban kit show --project /projects/foo` listed them on 2026-10-09 (notes shortened). Never
// the real foo: the fixture is copied into a temporary Kanban home.
const FOO_OVERRIDES = JSON.parse(
	readFileSync(join(import.meta.dirname, "fixtures", "foo-overrides-2026-10-09.json"), "utf8"),
) as Record<string, unknown>;

function writeConfig(path: string, config: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
}

const fooConfig = () => ({
	workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team", overrides: structuredClone(FOO_OVERRIDES) } } },
});

describe("kanban kit migrate-overrides (foo-like fixture)", () => {
	it("says where each of foo's overrides goes, and writes nothing on a dry run", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, fooConfig());
			const plan = await migrateWorkspaceOverrides({ workspaceId: "foo", dryRun: true });
			expect(plan.written).toBe(false);
			const table = Object.fromEntries(
				plan.rows.map((row) => [
					row.from,
					[
						...new Set(
							row.to.map((target) =>
								target.kind === "project"
									? `project ${target.key}`
									: target.kind === "dropped"
										? "dropped"
										: `kit ${target.kitName}`,
							),
						),
					],
				]),
			);
			expect(table).toEqual({
				"qa.blurb": ["project qa.blurb"],
				"qa.promptNotes.dbSetup": ["project qa.promptNotes.dbSetup"],
				"land.postLand": ["project land.postLand"],
				"dev.agent": ["project roles.dev.agent"],
				"qa.default.agent": ["project roles.qa.agent"],
				"qa.default.provider": ["project roles.qa.provider"],
				"qa.default.model": ["project roles.qa.model"],
				"plan.agent": ["project roles.plan.agent"],
				"plan.model": ["project roles.plan.model", "project roles.plan.provider"],
				// The fallback model stays the project's; its triggers are team.json's now.
				"escalate.to": [
					"project roles.fallback.agent",
					"project roles.fallback.model",
					"project roles.fallback.provider",
					"dropped",
				],
				"escalate.requireApproval": ["dropped"],
				"onOutage.then": ["dropped"],
				"tiers.tier3": ["kit foo-team"],
				"tiers.tier2": ["kit foo-team"],
				"tiers.qa": ["kit foo-team"],
				"tierNotes.qa": ["kit foo-team"],
				"qa.routes": ["kit foo-team"],
				description: ["kit foo-team"],
			});
			expect(Object.keys(table)).toHaveLength(18);
			expect(JSON.parse(readFileSync(globalConfigPath, "utf8"))).toEqual(fooConfig());
			expect(existsSync(join(getKanbanKitsPath(), "foo-team.json"))).toBe(false);
		});
	});

	it("moves the team keys into a user kit, keeps routing exactly the same, and logs the change", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, fooConfig());
			const before = resolveWorkspaceKit(parsePipelineConfig(fooConfig()).config, "foo", await loadKitCatalog());
			const result = await migrateWorkspaceOverrides({ workspaceId: "foo" });
			expect(result.written).toBe(true);
			const stored = JSON.parse(readFileSync(globalConfigPath, "utf8")) as {
				workspaces: { foo: { kit: { name: string; overrides: Record<string, unknown> } } };
			};
			expect(stored.workspaces.foo.kit.name).toBe("foo-team");
			expect(stored.workspaces.foo.kit.overrides).toMatchObject({
				"roles.dev.agent": "codex",
				"roles.fallback.agent": "codex",
				"roles.fallback.model": "us.moonshotai.kimi-k3",
				"roles.qa.model": "us.anthropic.claude-haiku-5-5",
			});
			expect(Object.keys(stored.workspaces.foo.kit.overrides).some((key) => key.startsWith("fallback."))).toBe(
				false,
			);

			const after = resolveWorkspaceKit(parsePipelineConfig(stored).config, "foo", await loadKitCatalog());
			expect(after.issues).toEqual([]);
			expect(after.kitName).toBe("foo-team");
			const { name: _a, ...routingAfter } = after.kit;
			const { name: _b, ...routingBefore } = before.kit;
			expect(routingAfter).toEqual(routingBefore);

			const userKit = JSON.parse(readFileSync(join(getKanbanKitsPath(), "foo-team.json"), "utf8"));
			expect(userKit).toMatchObject({ kit: 1, name: "foo-team", description: FOO_OVERRIDES.description });
			const history = await readKitSettingsHistory(getKitSettingsHistoryPath("foo"));
			expect(history[0]).toMatchObject({ key: "(kit)", from: "team", to: "foo-team", via: "kit migrate-overrides" });
			expect(history.find((entry) => entry.key === "escalate.to")).toMatchObject({
				from: FOO_OVERRIDES["escalate.to"],
			});

			// Doctor now has nothing to warn about, and a second run has nothing to do.
			const findings = checkKitProjectSettings({
				config: parsePipelineConfig(stored).config,
				catalog: await loadKitCatalog(),
				entries: [{ workspaceId: "foo" }],
			});
			expect(findings.map((finding) => finding.level)).toEqual(["pass"]);
			expect((await migrateWorkspaceOverrides({ workspaceId: "foo" })).unchanged).toBe(true);
		});
	});

	it("doctor warns about foo's team keys and legacy keys before the migration, pointing at the user's command", async () => {
		const findings = checkKitProjectSettings({
			config: parsePipelineConfig(fooConfig()).config,
			catalog: await loadKitCatalog(join(import.meta.dirname, "no-kits-here")),
			entries: [{ workspaceId: "foo" }],
		});
		expect(findings.map((finding) => finding.level)).toEqual(["warn", "warn"]);
		expect(findings[0]?.message).toContain("change kit team's team definition (description, fallback.on.conflict");
		expect(findings[0]?.message).toContain("they still apply");
		expect(findings[1]?.message).toContain("legacy override key(s) dev.agent (= roles.dev.agent)");
		expect(findings.every((finding) => finding.hint?.includes("kanban kit migrate-overrides --project foo"))).toBe(
			true,
		);
	});

	it("only drops team keys when nothing else is left, and refuses an existing kit name", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: {
					bar: {
						kit: {
							name: "team",
							overrides: { "escalate.to": { agent: "codex", model: "m1" }, "escalate.requireApproval": false },
						},
					},
				},
			});
			const result = await migrateWorkspaceOverrides({ workspaceId: "bar" });
			expect(result.toKit).toBe("team");
			expect(result.userKit).toBeNull();
			expect(
				(JSON.parse(readFileSync(globalConfigPath, "utf8")) as { workspaces: { bar: { kit: unknown } } }).workspaces
					.bar.kit,
			).toEqual({
				name: "team",
				overrides: {
					"roles.fallback.agent": "codex",
					"roles.fallback.model": "m1",
					"roles.fallback.provider": null,
				},
			});

			writeConfig(globalConfigPath, {
				workspaces: { bar: { kit: { name: "team", overrides: { "onFail.reworkRounds": 1 } } } },
			});
			await expect(migrateWorkspaceOverrides({ workspaceId: "bar", into: "team-local" })).rejects.toThrow(
				/not a user kit name/u,
			);
		});
	});
});
