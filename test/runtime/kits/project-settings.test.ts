import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { KitDocument } from "../../../src/kits/kit-schema";
import { createRoutingPolicy } from "../../../src/kits/policy";
import {
	classifyKitSettingKey,
	classifyStoredOverrides,
	readKitSettingsHistory,
	setProjectKitSetting,
	unsetProjectKitSetting,
} from "../../../src/kits/project-settings";
import { getBuiltInKits, loadKitCatalog, resolveWorkspaceKit } from "../../../src/kits/resolve-kit";
import { getKanbanKitsPath, getKitSettingsHistoryPath } from "../../../src/state/kanban-home";
import { createCardHistory, createEffectiveCard } from "../../utilities/effective-card";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

const team = () => {
	const kit = getBuiltInKits().get("team-cloud");
	if (!kit) {
		throw new Error("team kit missing");
	}
	return kit;
};

function writeConfig(path: string, config: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
}

function readWorkspace(path: string, workspaceId: string): Record<string, unknown> {
	const config = JSON.parse(readFileSync(path, "utf8")) as { workspaces: Record<string, Record<string, unknown>> };
	return config.workspaces[workspaceId] ?? {};
}

describe("project settings: which keys a project may set", () => {
	it("allows role model fields of roles the kit defines, and project facts", () => {
		for (const key of [
			"roles.dev.agent",
			"roles.dev.model",
			"roles.qa.provider",
			"roles.plan.tier",
			"roles.fallback.model",
		]) {
			expect(classifyKitSettingKey(key, team()).kind, key).toBe("role");
		}
		for (const key of [
			"qa.blurb",
			"qa.promptNotes.dbSetup",
			"qa.promptNotes",
			"qa.serversScript",
			"qa.preview",
			"land.postLand",
			"plan.rules.style",
			"checks",
			"checks.envFile",
			"checks.databaseUrlVar",
			"checks.setup",
			"checks.teardown",
		]) {
			expect(classifyKitSettingKey(key, team()).kind, key).toBe("fact");
		}
	});

	it("allows every other model the kit names: tier picks, QA route reviewers, plan candidates", () => {
		for (const key of [
			"tiers.tier3",
			"tiers.tier3.0.model",
			"tiers.tier3.1.provider",
			"tiers.tier2.1.default",
			"tiers.qa.0",
			"qa.routes.0.agent",
			"qa.routes.0.provider",
			"qa.routes.0.model",
			"plan.candidates.0.agent",
			"plan.candidates.0.model",
			"plan.candidates.0.model.provider",
			"plan.candidates.0.model.model",
			"plan.candidates.0.model.tier",
		]) {
			expect(classifyKitSettingKey(key, team()).kind, key).toBe("model");
		}
	});

	it("refuses a model key for a tier or list entry the kit doesn't have", () => {
		const message = (key: string) => {
			const classified = classifyKitSettingKey(key, team());
			return classified.kind === "invalid" ? classified.message : `not invalid: ${classified.kind}`;
		};
		expect(message("tiers.tier9")).toContain('kit team-cloud has no tier "tier9"');
		expect(message("tiers.tier3.2.model")).toContain("tiers.tier3 has no entry 2 (entries 0-1)");
		expect(message("tiers.tier3.x.model")).toContain("has no entry x");
		expect(message("qa.routes.1.model")).toContain("qa.routes has no entry 1 (entries 0-0)");
		expect(message("plan.candidates.3.agent")).toContain("plan.candidates has no entry 3");
		expect(message("onFail.runoff.models.0.model")).toContain("onFail.runoff.models has no entry 0 (no entries)");
	});

	it("refuses the team definition: flow keys, fallback triggers and approval, routes, tiers, features", () => {
		for (const key of [
			"onFail.then",
			"onFail.reworkRounds",
			"fallback.on.qaFails",
			"fallback.requireApproval",
			"fallback.outageAfterMin",
			"qa.enabled",
			"qa.requireDifferentVendor",
			"qa.routes",
			"qa.routes.0.devModel",
			"qa.routes.0.rules",
			"qa.routes.0",
			"qa.rules.drive",
			"tiers",
			"tiers.tier2.0.note",
			"tierNotes.qa",
			"plan.candidates.0.note",
			"dropped",
			"features",
			"description",
			"roles.dev.note",
		]) {
			const classified = classifyKitSettingKey(key, team());
			expect(classified.kind, key).toBe("team");
			expect(classified.kind === "team" && classified.message).toContain(
				"part of the team definition (kit team-cloud)",
			);
		}
	});

	it("refuses unknown roles, roles the kit doesn't define, legacy keys and unknown keys", () => {
		const message = (key: string, kit = team()) => {
			const classified = classifyKitSettingKey(key, kit);
			return classified.kind === "invalid" ? classified.message : `not invalid: ${classified.kind}`;
		};
		expect(message("roles.senior.model")).toContain('unknown role "senior"');
		expect(message("roles.dev")).toContain("set one field of a role");
		expect(message("roles.dev.model.x")).toContain("set one field of a role");
		const defaultKit = getBuiltInKits().get("default");
		expect(defaultKit && message("roles.dev.agent", defaultKit)).toContain("kit default defines no dev role");
		expect(message("dev.agent")).toBe("dev.agent is a legacy key; use roles.dev.agent");
		expect(message("escalate.to")).toContain("legacy key");
		expect(message("name")).toContain("identifies the kit");
		expect(message("nonsense.key")).toContain("not a kit key");
	});

	it("splits foo's stored overrides into project settings, legacy keys and team keys", () => {
		const overrides = JSON.parse(
			readFileSync(join(import.meta.dirname, "fixtures", "foo-overrides-2026-10-09.json"), "utf8"),
		) as Record<string, unknown>;
		const classified = classifyStoredOverrides(overrides, team());
		expect(Object.keys(classified.project).sort()).toEqual([
			"land.postLand",
			"qa.blurb",
			"qa.promptNotes.dbSetup",
			"roles.dev.agent",
			"roles.fallback.agent",
			"roles.fallback.model",
			"roles.fallback.provider",
			"roles.plan.agent",
			"roles.plan.model",
			"roles.plan.provider",
			"roles.qa.agent",
			"roles.qa.model",
			"roles.qa.provider",
			"tiers.qa",
			"tiers.tier2",
			"tiers.tier3",
		]);
		expect(Object.keys(classified.team).sort()).toEqual([
			"description",
			"fallback.on.conflict",
			"fallback.on.outage",
			"fallback.on.qaFails",
			"fallback.on.qaStalled",
			"fallback.on.unchanged",
			"fallback.requireApproval",
			"qa.routes",
			"tierNotes.qa",
		]);
		expect(classified.invalid).toEqual([]);
		expect(classified.legacy.map((entry) => entry.from).sort()).toEqual([
			"dev.agent",
			"escalate.requireApproval",
			"escalate.to",
			"onOutage.then",
			"plan.agent",
			"plan.model",
			"qa.default.agent",
			"qa.default.model",
			"qa.default.provider",
		]);
	});
});

describe("project settings: set and unset", () => {
	it("sets and unsets each model the kit names outside its roles, in effect at once", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			// A user kit with a runoff, since no built-in kit races.
			const kitsDir = getKanbanKitsPath();
			mkdirSync(kitsDir, { recursive: true });
			const race = {
				...team(),
				name: "race",
				onFail: {
					...team().onFail,
					runoff: { models: [{ agent: "cline", provider: "bedrock", model: "us.openai.gpt-6.1-sol" }] },
				},
			};
			writeFileSync(join(kitsDir, "race.json"), JSON.stringify(race));
			writeConfig(globalConfigPath, { workspaces: { foo: { kit: { name: "race" } } } });
			const by = { kind: "orchestrator", taskId: "__home_agent__:foo:claude" } as const;
			const resolve = async () =>
				resolveWorkspaceKit(
					parsePipelineConfig(JSON.parse(readFileSync(globalConfigPath, "utf8"))).config,
					"foo",
					await loadKitCatalog(),
				);
			const settings: Array<[string, unknown, (kit: KitDocument) => unknown]> = [
				["tiers.tier3.0.model", "m-tier", (kit) => kit.tiers?.tier3?.[0]?.model],
				["tiers.tier3.0.provider", "lemonade", (kit) => kit.tiers?.tier3?.[0]?.provider],
				["tiers.tier3.1.default", false, (kit) => kit.tiers?.tier3?.[1]?.default],
				["qa.routes.0.agent", "codex", (kit) => kit.qa?.routes?.[0]?.agent],
				["qa.routes.0.provider", null, (kit) => kit.qa?.routes?.[0]?.provider],
				["qa.routes.0.model", "m-route", (kit) => kit.qa?.routes?.[0]?.model],
				["plan.candidates.0.agent", "codex", (kit) => kit.plan?.candidates?.[0]?.agent],
				["plan.candidates.0.model.model", "m-plan", (kit) => kit.plan?.candidates?.[0]?.model],
				["onFail.runoff.models.0.agent", "codex", (kit) => kit.onFail?.runoff?.models[0]?.agent],
				["onFail.runoff.models.0.provider", null, (kit) => kit.onFail?.runoff?.models[0]?.provider],
				["onFail.runoff.models.0.model", "m-race", (kit) => kit.onFail?.runoff?.models[0]?.model],
			];
			for (const [key, value] of settings) {
				const result = await setProjectKitSetting({ workspaceId: "foo", key, value, by });
				expect(result.changes, key).toEqual([expect.objectContaining({ key, to: value, via: "kit set" })]);
			}
			const resolved = await resolve();
			expect(resolved.issues).toEqual([]);
			for (const [key, value, read] of settings) {
				expect(read(resolved.kit), key).toEqual(key === "plan.candidates.0.model.model" ? { model: value } : value);
			}
			// The entries' other fields stay the kit's; a list holding a project setting reads as the project's.
			expect(resolved.kit.qa?.routes?.[0]?.devModel).toBe(team().qa?.routes?.[0]?.devModel);
			expect(resolved.kit.tiers?.tier3?.[1]?.model).toBe(team().tiers?.tier3?.[1]?.model);
			expect(resolved.sources["qa.routes"]).toBe("project");
			expect(resolved.sources["tiers.tier2"]).toBe("race");

			// A whole tier's picks, and a candidate's tier instead of its model.
			await setProjectKitSetting({ workspaceId: "foo", key: "tiers.qa", value: [{ model: "m-qa" }], by });
			await setProjectKitSetting({ workspaceId: "foo", key: "plan.candidates.0.model.tier", value: "qa", by });
			expect((await resolve()).kit.tiers?.qa).toEqual([{ model: "m-qa" }]);
			expect((await resolve()).kit.plan?.candidates?.[0]?.model).toEqual({ tier: "qa" });

			for (const key of ["tiers.tier3", "qa.routes.0", "plan.candidates", "onFail.runoff.models.0.agent"]) {
				await unsetProjectKitSetting({ workspaceId: "foo", key, by });
			}
			await unsetProjectKitSetting({ workspaceId: "foo", key: "onFail.runoff", by });
			await unsetProjectKitSetting({ workspaceId: "foo", key: "tiers.qa", by });
			expect(readWorkspace(globalConfigPath, "foo").kit).toEqual({ name: "race", overrides: {} });
			const { name: _resolvedName, ...back } = (await resolve()).kit;
			const { name: _raceName, ...kitValues } = (
				await loadKitCatalog().then((catalog) =>
					resolveWorkspaceKit(
						parsePipelineConfig({ workspaces: { foo: { kit: { name: "race" } } } }).config,
						"foo",
						catalog,
					),
				)
			).kit;
			expect(back).toEqual(kitValues);
		});
	});

	it("still refuses the flow around the models: a route's devModel, a tier note, the runoff list", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, { workspaces: { foo: { kit: { name: "team-cloud" } } } });
			const by = { kind: "orchestrator", taskId: "__home_agent__:foo:claude" } as const;
			for (const [key, value] of [
				["qa.routes.0.devModel", ".*"],
				["qa.routes", []],
				["tiers.tier3.0.note", "x"],
				["tiers", {}],
				["onFail.runoff", null],
				["qa.requireDifferentVendor", false],
			] as const) {
				await expect(setProjectKitSetting({ workspaceId: "foo", key, value, by }), key).rejects.toThrow(
					/part of the team definition/u,
				);
			}
			await expect(
				setProjectKitSetting({ workspaceId: "foo", key: "tiers.tier3.5.model", value: "m", by }),
			).rejects.toThrow(/has no entry 5/u);
			expect(readWorkspace(globalConfigPath, "foo").kit).toEqual({ name: "team-cloud" });
		});
	});

	it("sets the scripted checks' environment and refuses an env file outside the project", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team-cloud" } } },
			});
			const set = async (key: string, value: unknown) =>
				await setProjectKitSetting({ workspaceId: "foo", key, value, by: { kind: "user" } });
			await set("checks.envFile", ".env");
			await set("checks.databaseUrlVar", "DATABASE_URL");
			await set("checks.setup", "npx prisma migrate deploy");
			await expect(set("checks.envFile", "../other/.env")).rejects.toThrow("relative to the project");
			await expect(set("checks.envFile", "/root/.env")).rejects.toThrow("relative to the project");
			await expect(set("checks.databaseUrlVar", "DATABASE URL")).rejects.toThrow("environment variable name");
			await expect(set("checks.envFiles", ".env")).rejects.toThrow();

			const resolved = resolveWorkspaceKit(
				parsePipelineConfig(JSON.parse(readFileSync(globalConfigPath, "utf8"))).config,
				"foo",
				await loadKitCatalog(),
			);
			expect(resolved.kit.checks).toEqual({
				envFile: ".env",
				databaseUrlVar: "DATABASE_URL",
				setup: "npx prisma migrate deploy",
			});
		});
	});

	it("sets a role's model at once (kit < project), logs who changed it, and unset brings the kit's value back", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team-cloud" } } },
			});
			const result = await setProjectKitSetting({
				workspaceId: "foo",
				key: "roles.fallback.model",
				value: "us.anthropic.claude-opus-5-5",
				by: { kind: "orchestrator", taskId: "__home_agent__:foo:claude" },
				now: () => new Date("2026-10-09T10:00:00.000Z"),
			});
			expect(result.changes).toEqual([
				expect.objectContaining({ key: "roles.fallback.model", to: "us.anthropic.claude-opus-5-5" }),
			]);
			expect(readWorkspace(globalConfigPath, "foo").kit).toEqual({
				name: "team-cloud",
				overrides: { "roles.fallback.model": "us.anthropic.claude-opus-5-5" },
			});

			const catalog = await loadKitCatalog();
			const resolve = async () =>
				resolveWorkspaceKit(
					parsePipelineConfig(JSON.parse(readFileSync(globalConfigPath, "utf8"))).config,
					"foo",
					catalog,
				);
			const resolved = await resolve();
			expect(resolved.sources["roles.fallback.model"]).toBe("project");
			// The kit's flow still decides when; the project only picked the model.
			expect(
				createRoutingPolicy(resolved.kit).onFail({
					dev: createEffectiveCard({ agentId: "cline", model: "us.openai.gpt-6.1-sol" }),
					cause: "stalled",
					verdict: null,
					history: createCardHistory(),
					limits: { maxFailRounds: 3 },
				}),
			).toMatchObject({ action: "escalate", to: { model: { model: "us.anthropic.claude-opus-5-5" } } });

			await unsetProjectKitSetting({ workspaceId: "foo", key: "roles.fallback", by: { kind: "user" } });
			expect(readWorkspace(globalConfigPath, "foo").kit).toEqual({ name: "team-cloud", overrides: {} });
			expect((await resolve()).kit.roles?.fallback?.tier).toBe("tier2");

			const history = await readKitSettingsHistory(getKitSettingsHistoryPath("foo"));
			expect(history).toEqual([
				{
					at: "2026-10-09T10:00:00.000Z",
					workspaceId: "foo",
					kitName: "team-cloud",
					key: "roles.fallback.model",
					to: "us.anthropic.claude-opus-5-5",
					by: { kind: "orchestrator", taskId: "__home_agent__:foo:claude" },
					via: "kit set",
				},
				expect.objectContaining({
					key: "roles.fallback.model",
					from: "us.anthropic.claude-opus-5-5",
					by: { kind: "user" },
					via: "kit unset",
				}),
			]);
			expect(history[1] && "to" in history[1]).toBe(false);
		});
	});

	it("refuses team keys and invalid values without writing anything", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			const original = {
				workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team-cloud", overrides: {} } } },
			};
			writeConfig(globalConfigPath, original);
			const by = { kind: "user" } as const;
			await expect(
				setProjectKitSetting({ workspaceId: "foo", key: "fallback.requireApproval", value: true, by }),
			).rejects.toThrow(/part of the team definition/u);
			await expect(
				setProjectKitSetting({ workspaceId: "foo", key: "onFail.then", value: "stop", by }),
			).rejects.toThrow(/part of the team definition/u);
			await expect(
				setProjectKitSetting({ workspaceId: "foo", key: "roles.dev.tier", value: "tier9", by }),
			).rejects.toThrow(/tier "tier9" is not in tiers/u);
			await expect(
				setProjectKitSetting({ workspaceId: "foo", key: "roles.dev.agent", value: "nobody", by }),
			).rejects.toThrow(/would not resolve/u);
			await expect(unsetProjectKitSetting({ workspaceId: "foo", key: "qa.blurb", by })).rejects.toThrow(
				/no project setting qa\.blurb/u,
			);
			expect(JSON.parse(readFileSync(globalConfigPath, "utf8"))).toEqual(original);
			expect(await readKitSettingsHistory(getKitSettingsHistoryPath("foo"))).toEqual([]);
		});
	});

	it("a new role key replaces the legacy key it covers, and keeps the stored team keys", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: {
					foo: {
						kit: { name: "team-cloud", overrides: { "dev.agent": "codex", "onOutage.then": "orchestrator" } },
					},
				},
			});
			const result = await setProjectKitSetting({
				workspaceId: "foo",
				key: "roles.dev.agent",
				value: "cline",
				by: { kind: "user" },
			});
			expect(readWorkspace(globalConfigPath, "foo").kit).toEqual({
				name: "team-cloud",
				overrides: { "onOutage.then": "orchestrator", "roles.dev.agent": "cline" },
			});
			expect(result.changes.map(({ key, from, to }) => ({ key, from, to }))).toEqual([
				{ key: "dev.agent", from: "codex", to: undefined },
				{ key: "roles.dev.agent", from: undefined, to: "cline" },
			]);
			// A team key stored before the split is the user's to remove (kit apply --unset / migrate-overrides).
			await expect(
				unsetProjectKitSetting({ workspaceId: "foo", key: "onOutage.then", by: { kind: "user" } }),
			).rejects.toThrow(/legacy key/u);
		});
	});
});
