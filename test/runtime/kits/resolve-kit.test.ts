import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { buildKitReport, formatKitReport } from "../../../src/kits/kit-report";
import { kitDocumentSchema } from "../../../src/kits/kit-schema";
import {
	getDefaultKit,
	loadKitCatalog,
	resolveKitByName,
	resolveKitLayers,
	resolveWorkspaceKit,
} from "../../../src/kits/resolve-kit";
import { getLegacyTeamKit } from "../../utilities/team-kits";
import { createTempDir } from "../../utilities/temp-dir";

async function builtInCatalog() {
	const { path, cleanup } = createTempDir("kanban-kits-");
	try {
		return await loadKitCatalog(path);
	} finally {
		cleanup();
	}
}

describe("resolveKitLayers", () => {
	const named = kitDocumentSchema.parse({
		kit: 1,
		name: "mine",
		roles: { qa: { agent: "codex" } },
		qa: { enabled: true, skip: { roles: ["qa"] }, blurb: "kit blurb" },
		onFail: { rework: "same-model", reworkRounds: 2 },
	});

	it("takes the project setting, then the kit, then default", () => {
		const resolved = resolveKitLayers(getDefaultKit(), named, { "qa.blurb": "override blurb" });
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		expect(resolved.kit.qa?.blurb).toBe("override blurb");
		expect(resolved.kit.onFail?.reworkRounds).toBe(2);
		expect(resolved.kit.onFail?.then).toBe("stop");
		expect(resolved.sources["qa.blurb"]).toBe("project");
		expect(resolved.sources["onFail.reworkRounds"]).toBe("mine");
		expect(resolved.sources["onFail.then"]).toBe("default");
		expect(resolved.sources["qa.routes"]).toBe("default");
	});

	it("replaces arrays instead of merging them", () => {
		const resolved = resolveKitLayers(getDefaultKit(), named, {});
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		// default has ["qa", "triage", "calibration"]; the kit's one-element list wins as a whole.
		expect(resolved.kit.qa?.skip?.roles).toEqual(["qa"]);
		const overridden = resolveKitLayers(getDefaultKit(), named, { "qa.skip.roles": ["triage"] });
		expect(overridden.ok && overridden.kit.qa?.skip?.roles).toEqual(["triage"]);
	});

	it("refuses unknown override keys and keys that identify the kit", () => {
		const unknown = resolveKitLayers(getDefaultKit(), named, { "qa.blurbs": "x" });
		expect(unknown.ok).toBe(false);
		expect(resolveKitLayers(getDefaultKit(), named, { name: "team" }).ok).toBe(false);
		const preset = resolveKitLayers(getDefaultKit(), named, { preset: "cloud" });
		expect(!preset.ok && preset.error).toContain("identifies the kit");
		expect(resolveKitLayers(getDefaultKit(), named, { "qa.enabled.x": true }).ok).toBe(false);
		expect(resolveKitLayers(getDefaultKit(), named, { "qa..blurb": "x" }).ok).toBe(false);
	});
});

describe("roles: model and tier exclude each other across layers", () => {
	// A kit with tiers: the legacy-team fixture (the built-in team-cloud kit before presets).
	const team = async (overrides: Record<string, unknown>) => {
		const resolved = resolveKitLayers(getDefaultKit(), getLegacyTeamKit(), overrides);
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		return resolved;
	};

	it("a project's roles.dev.model replaces the kit's roles.dev.tier, and its source is project", async () => {
		const resolved = await team({
			"roles.dev.model": "us.anthropic.claude-opus-5-5",
			"roles.dev.provider": "bedrock",
		});
		expect(resolved.kit.roles?.dev).toMatchObject({ agent: "cline", model: "us.anthropic.claude-opus-5-5" });
		expect(resolved.kit.roles?.dev?.tier).toBeUndefined();
		expect(resolved.sources["roles.dev.model"]).toBe("project");
		expect(resolved.sources["roles.dev.agent"]).toBe("legacy-team");
	});

	it("a project's roles.fallback.tier replaces an explicit model", async () => {
		const resolved = await team({ "roles.fallback.model": "x", "roles.fallback.tier": "tier3" });
		expect(resolved.kit.roles?.fallback?.tier).toBe("tier3");
		expect(resolved.kit.roles?.fallback?.model).toBeUndefined();
	});

	it("translates legacy override keys into roles and the fallback flow (foo's 2026-10-08 overrides)", async () => {
		const resolved = await team({
			"dev.agent": "codex",
			"qa.default.agent": "cline",
			"qa.default.provider": "bedrock",
			"qa.default.model": "us.anthropic.claude-haiku-5-5",
			"plan.agent": "cline",
			"plan.model": { provider: "bedrock", model: "us.anthropic.claude-opus-5-5" },
			"escalate.to": { agent: "codex", model: "us.moonshotai.kimi-k3" },
			"escalate.requireApproval": false,
			"onOutage.then": "escalate",
		});
		expect(resolved.kit.roles).toMatchObject({
			dev: { agent: "codex", tier: "tier3" },
			qa: { agent: "cline", provider: "bedrock", model: "us.anthropic.claude-haiku-5-5" },
			plan: { agent: "cline", provider: "bedrock", model: "us.anthropic.claude-opus-5-5" },
			fallback: { agent: "codex", model: "us.moonshotai.kimi-k3", provider: null },
		});
		expect(resolved.kit.fallback?.on).toEqual({
			qaFails: true,
			qaStalled: true,
			unchanged: true,
			conflict: true,
			outage: true,
		});
		expect(resolved.sources["roles.dev.agent"]).toBe("project");
		expect(resolved.sources["roles.dev.tier"]).toBe("legacy-team");
		for (const key of ["dev", "escalate", "onOutage"]) {
			expect(key in resolved.kit).toBe(false);
		}
	});

	it("legacy escalate.to orchestrator turns every fallback trigger off, outages included", async () => {
		const resolved = await team({ "escalate.to": "orchestrator", "onOutage.then": "escalate" });
		expect(Object.values(resolved.kit.fallback?.on ?? {})).toEqual([false, false, false, false, false]);
	});
});

describe("resolveWorkspaceKit", () => {
	it("gives a workspace without a kit entry the default kit", async () => {
		const catalog = await builtInCatalog();
		const { config } = parsePipelineConfig({});
		const resolved = resolveWorkspaceKit(config, "kanban-2uge", catalog);
		expect(resolved.kitName).toBe("default");
		expect(resolved.requestedKitName).toBeNull();
		expect(resolved.kit.qa?.enabled).toBe(false);
		expect(resolved.issues).toEqual([]);
	});

	it("never inherits another workspace's kit or overrides", async () => {
		const catalog = await builtInCatalog();
		const { config } = parsePipelineConfig({
			workspaces: {
				foo: {
					landing: { mode: "qa" },
					kit: { name: "team", preset: "cloud", overrides: { "qa.blurb": "Project: Pawsome" } },
				},
				"kanban-2uge": { landing: { mode: "off" } },
			},
		});
		const foo = resolveWorkspaceKit(config, "foo", catalog);
		expect(foo.kitName).toBe("team");
		expect(foo.presetName).toBe("cloud");
		expect(foo.kitLabel).toBe("team (cloud)");
		expect(foo.kit.qa?.blurb).toBe("Project: Pawsome");
		expect(foo.sources["qa.blurb"]).toBe("project");
		expect(foo.sources["qa.enabled"]).toBe("team");
		expect(foo.sources["roles.dev.model"]).toBe("preset:cloud");
		for (const workspaceId of ["kanban-2uge", "brand-new"]) {
			const other = resolveWorkspaceKit(config, workspaceId, catalog);
			expect(other.kitName).toBe("default");
			expect(other.kit.qa?.enabled).toBe(false);
			expect(other.kit.qa?.blurb).toBe("");
		}
	});

	it("runs a workspace whose config still names a renamed kit on the team kit and its preset", async () => {
		const catalog = await builtInCatalog();
		const pairs = [
			["team-cloud", "cloud"],
			["team-local", "lemonade"],
			["team-cline", "cline"],
		] as const;
		const { config } = parsePipelineConfig({
			workspaces: Object.fromEntries(
				pairs.flatMap(([oldName, preset]) => [
					[
						oldName,
						{ landing: { mode: "qa" }, kit: { name: oldName, overrides: { "qa.blurb": "Project: Pawsome" } } },
					],
					[
						preset,
						{
							landing: { mode: "qa" },
							kit: { name: "team", preset, overrides: { "qa.blurb": "Project: Pawsome" } },
						},
					],
				]),
			),
		});
		for (const [oldName, preset] of pairs) {
			const old = resolveWorkspaceKit(config, oldName, catalog);
			const current = resolveWorkspaceKit(config, preset, catalog);
			expect(old.kitName).toBe("team");
			expect(old.presetName).toBe(preset);
			expect(old.issues).toEqual([]);
			expect(old.kit).toEqual(current.kit);
			expect(old.sources).toEqual(current.sources);
		}
	});

	it("answers a command naming a renamed kit with the kit and preset now, and checks the preset", async () => {
		const catalog = await builtInCatalog();
		const resolved = resolveKitByName(catalog, "team-local");
		expect(resolved.ok).toBe(false);
		expect(resolved.ok ? "" : resolved.error).toBe(
			'kit "team-local" is now team (lemonade) (2026-10-12); use team --preset lemonade',
		);
		expect(resolveKitByName(catalog, "team", {}, "lemonade").ok).toBe(true);
		// The team kit without a preset is a custom team: it resolves, with no models of its own.
		const custom = resolveKitByName(catalog, "team");
		expect(custom.ok && custom.kit.roles?.dev?.agent).toBeUndefined();
		const misuse = resolveKitByName(catalog, "default", {}, "cloud");
		expect(misuse.ok ? "" : misuse.error).toContain('kit "default" has no presets');
		const unknown = resolveKitByName(catalog, "team", {}, "triton");
		expect(unknown.ok ? "" : unknown.error).toBe('unknown preset "triton" (known: cloud, cline, lemonade)');
	});

	it("falls back to default with an issue when the kit is unknown or its overrides are invalid", async () => {
		const catalog = await builtInCatalog();
		const { config } = parsePipelineConfig({
			workspaces: {
				a: { kit: { name: "gone" } },
				b: { kit: { name: "team", preset: "cloud", overrides: { "qa.nope": 1 } } },
				c: { kit: { name: "team", preset: "nope" } },
				d: { kit: { name: "default", preset: "cloud" } },
			},
		});
		for (const workspaceId of ["a", "b", "c", "d"]) {
			const resolved = resolveWorkspaceKit(config, workspaceId, catalog);
			expect(resolved.kitName).toBe("default");
			expect(resolved.kit.qa?.enabled).toBe(false);
			expect(resolved.issues).toHaveLength(1);
		}
	});
});

describe("loadKitCatalog", () => {
	it("loads user kits and refuses built-in names, mismatched names and invalid files", async () => {
		const { path, cleanup } = createTempDir("kanban-kits-");
		try {
			mkdirSync(path, { recursive: true });
			writeFileSync(
				join(path, "solo.json"),
				JSON.stringify({ kit: 1, name: "solo", dev: { agent: "codex" }, qa: { enabled: false } }),
			);
			writeFileSync(join(path, "team.json"), JSON.stringify({ kit: 1, name: "team" }));
			// The old name of a renamed built-in kit stays reserved.
			writeFileSync(join(path, "team-cloud.json"), JSON.stringify({ kit: 1, name: "team-cloud" }));
			writeFileSync(join(path, "other.json"), JSON.stringify({ kit: 1, name: "renamed" }));
			writeFileSync(join(path, "broken.json"), "{");
			writeFileSync(join(path, "typo.json"), JSON.stringify({ kit: 1, name: "typo", qa: { enable: true } }));
			const catalog = await loadKitCatalog(path);
			expect([...catalog.kits.keys()].sort()).toEqual(["default", "solo", "team"]);
			expect(catalog.kits.get("team")?.origin).toEqual({ kind: "built-in" });
			expect([...catalog.presets.keys()]).toEqual(["cloud", "cline", "lemonade"]);
			expect(catalog.kits.get("solo")?.origin).toEqual({ kind: "user", path: join(path, "solo.json") });
			expect(catalog.errors.map((error) => error.path).sort()).toEqual(
				["broken.json", "other.json", "team-cloud.json", "team.json", "typo.json"].map((file) => join(path, file)),
			);
			const solo = resolveKitByName(catalog, "solo");
			// A user kit's legacy dev.agent is its roles.dev.agent.
			expect(solo.ok && solo.sources["roles.dev.agent"]).toBe("solo");
			expect(solo.ok && solo.kit.roles?.dev).toEqual({ agent: "codex" });
			expect(solo.ok && "dev" in solo.kit).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("reports an unreadable kits directory instead of throwing", async () => {
		const { path, cleanup } = createTempDir("kanban-kits-");
		try {
			const notADir = join(path, "kits");
			writeFileSync(notADir, "");
			const catalog = await loadKitCatalog(notADir);
			expect([...catalog.kits.keys()]).toEqual(["default", "team"]);
			expect(catalog.errors).toEqual([{ path: notADir, error: expect.stringContaining("ENOTDIR") }]);
		} finally {
			cleanup();
		}
	});

	it("works without a kits directory", async () => {
		const { path, cleanup } = createTempDir("kanban-kits-");
		try {
			const catalog = await loadKitCatalog(join(path, "missing"));
			expect([...catalog.kits.keys()]).toEqual(["default", "team"]);
			expect(catalog.errors).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe("kanban kit show report", () => {
	it("lists each resolved value with its source and the evaluator's answers", async () => {
		const catalog = await builtInCatalog();
		const resolved = resolveKitByName(catalog, "team", { "qa.blurb": "Project: Pawsome" }, "cloud");
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		const report = buildKitReport({
			kitName: "team (cloud)",
			resolved,
			workspaceId: "foo",
			selectedAgentId: "claude",
			maxFailRounds: 3,
			outageMaxMin: 360,
			config: parsePipelineConfig({}).config,
		});
		// Kanban refuses no model on any role: the report has no vetting section.
		expect(formatKitReport(report).join("\n")).not.toMatch(/REFUSED|vetted model registry/u);
		const sourceOf = (key: string) => report.values.find((row) => row.key === key)?.source;
		expect(sourceOf("qa.blurb")).toBe("project");
		expect(sourceOf("qa.enabled")).toBe("team");
		expect(sourceOf("roles.dev.model")).toBe("preset:cloud");
		expect(sourceOf("land.postLand")).toBe("default");
		expect(report.devAssignment).toEqual({
			agentId: "codex",
			model: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" },
		});
		expect(report.qa[0]).toMatchObject({ devModel: { model: "us.openai.gpt-6.1-sol" }, answer: { kind: "qa" } });
		expect(report.recommendedLandingMode).toBe("qa");
		expect(formatKitReport(report).join("\n")).toContain('qa.blurb = "Project: Pawsome"  [project]');
		const text = formatKitReport(report).join("\n");
		// The fallback takes an outage-held card over once recovery would give up, as every team does.
		expect(text).toContain("After 360 min of provider outage: take over on codex bedrock/us.moonshotai.kimi-k3");
		expect(text).toContain("Team definition (kit team (cloud);");
		expect(text).toMatch(
			/ {2}dev {7}codex on bedrock\/us\.openai\.gpt-6\.1-sol {2}\[agent: preset:cloud, model: preset:cloud\]/u,
		);
		expect(text).toMatch(/fallback {2}codex on bedrock\/us\.moonshotai\.kimi-k3/u);
		expect(text).toContain(
			"    on: 3 failed QA round(s); QA stalled; a rework that came back unchanged; a merge conflict its reworks didn't fix; a provider outage hold of 360 min",
		);
		expect(text).toContain("    approval: none, the sibling starts at once");
		expect(report.fallback).toMatchObject({
			on: ["qaFails", "qaStalled", "unchanged", "conflict", "outage"],
			off: [],
			requireApproval: false,
		});
	});

	it("shows the outage takeover the legacy onOutage/escalate keys ask for", async () => {
		const resolved = resolveKitLayers(getDefaultKit(), getLegacyTeamKit(), {
			"onOutage.then": "escalate",
			"onOutage.afterMin": 45,
			"escalate.to": { agent: "codex", provider: "bedrock", model: "us.moonshotai.kimi-k3" },
			"escalate.requireApproval": false,
		});
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		const lines = formatKitReport(
			buildKitReport({
				kitName: "legacy-team",
				resolved,
				workspaceId: "foo",
				selectedAgentId: "claude",
				maxFailRounds: 3,
				outageMaxMin: 360,
				config: parsePipelineConfig({}).config,
			}),
		);
		expect(lines).toContain("After 45 min of provider outage: take over on codex bedrock/us.moonshotai.kimi-k3");
	});
});
