import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeKitChoiceRole } from "../../../src/core/kit-choice-display";
import { listKitChoices, resolveNewProjectKit } from "../../../src/kits/kit-choices";
import { loadKitCatalog } from "../../../src/kits/resolve-kit";
import { createTempDir } from "../../utilities/temp-dir";

function writeUserKit(kitsDir: string, name: string, kit: Record<string, unknown>): void {
	mkdirSync(kitsDir, { recursive: true });
	writeFileSync(join(kitsDir, `${name}.json`), JSON.stringify({ kit: 1, name, ...kit }));
}

describe("kit choices for a new project", () => {
	it("lists default first, then the team kit, then user kits, each with its four roles, and the team kit's presets", async () => {
		const { path: kitsDir, cleanup } = createTempDir("kanban-kit-choices-");
		try {
			writeUserKit(kitsDir, "team-foo", {
				description: "Foo's team",
				roles: { dev: { agent: "claude", model: "sonnet" } },
			});
			writeUserKit(kitsDir, "alpha", {});
			writeFileSync(join(kitsDir, "broken.json"), "{");
			const choices = listKitChoices(await loadKitCatalog(kitsDir));
			expect(choices.defaultKitName).toBe("default");
			expect(choices.teamKitName).toBe("team");
			expect(choices.kits.map((kit) => kit.name)).toEqual(["default", "team", "alpha", "team-foo"]);
			expect(choices.presets.map((preset) => preset.name)).toEqual(["cloud", "cline", "lemonade"]);
			for (const preset of choices.presets) {
				expect(preset.description).toBeTruthy();
				expect(preset.roles.map((role) => role.role)).toEqual(["dev", "qa", "plan", "fallback"]);
				// Every preset names the dev and QA agents a custom team must set itself.
				expect(preset.roles.slice(0, 2).every((role) => role.agentId !== null)).toBe(true);
			}
			for (const kit of choices.kits) {
				expect(kit.roles.map((role) => role.role)).toEqual(["dev", "qa", "plan", "fallback"]);
			}
			const foo = choices.kits.find((kit) => kit.name === "team-foo");
			expect(foo).toMatchObject({ origin: "user", description: "Foo's team" });
			expect(foo?.roles[0]).toEqual({
				role: "dev",
				defined: true,
				agentId: "claude",
				provider: null,
				model: "sonnet",
				tier: null,
			});
			expect(choices.kits[0]?.roles.every((role) => !role.defined)).toBe(true);
			// The tier is resolved to its model, as kit show does.
			const cline = choices.presets.find((preset) => preset.name === "cline");
			expect(cline?.roles[0]).toMatchObject({ agentId: "cline", tier: "dev", provider: "cline-pass" });
			expect(cline?.roles[0]?.model).toMatch(/^cline-pass\//);
			const cloud = choices.presets.find((preset) => preset.name === "cloud");
			expect(cloud?.roles.map((role) => [role.role, role.agentId, role.model])).toEqual([
				["dev", "codex", "us.openai.gpt-6.1-sol"],
				["qa", "cline", "us.anthropic.claude-haiku-5-5"],
				["plan", "cline", "us.anthropic.claude-opus-5-5"],
				["fallback", "codex", "us.moonshotai.kimi-k3"],
			]);
			expect(choices.errors.map((error) => error.name)).toEqual([join(kitsDir, "broken.json")]);
		} finally {
			cleanup();
		}
	});

	it("takes default for no name and refuses an unknown or renamed kit with the resolver's reason", async () => {
		const catalog = await loadKitCatalog(join(tmpdir(), "kanban-no-user-kits"));
		const none = { name: "default", preset: null, roleSettings: {} };
		expect(resolveNewProjectKit(catalog, {})).toEqual(none);
		expect(resolveNewProjectKit(catalog, { kit: " " })).toEqual(none);
		expect(resolveNewProjectKit(catalog, { kit: "team", preset: "lemonade" })).toEqual({
			name: "team",
			preset: "lemonade",
			roleSettings: {},
		});
		expect(() => resolveNewProjectKit(catalog, { kit: "nope" })).toThrow(/unknown kit "nope"/);
		expect(() => resolveNewProjectKit(catalog, { kit: "team-local" })).toThrow(/is now team \(lemonade\)/);
		expect(() => resolveNewProjectKit(catalog, { kit: "team" })).toThrow(/needs its models/);
		expect(() => resolveNewProjectKit(catalog, { kit: "team", preset: "nope" })).toThrow(/unknown preset "nope"/);
		expect(() => resolveNewProjectKit(catalog, { kit: "default", preset: "cloud" })).toThrow(/has no presets/);
	});

	it("checks a custom team's role settings before anything is made: role keys only, dev and QA agents", async () => {
		const catalog = await loadKitCatalog(join(tmpdir(), "kanban-no-user-kits"));
		const roleSettings = { "roles.dev.agent": "codex", "roles.qa.agent": "cline", "roles.qa.model": "m" };
		expect(resolveNewProjectKit(catalog, { kit: "team", preset: null, roleSettings })).toEqual({
			name: "team",
			preset: null,
			roleSettings,
		});
		expect(() =>
			resolveNewProjectKit(catalog, { kit: "team", preset: null, roleSettings: { "roles.dev.agent": "codex" } }),
		).toThrow(/needs roles\.qa\.agent/);
		expect(() =>
			resolveNewProjectKit(catalog, {
				kit: "team",
				preset: null,
				roleSettings: { ...roleSettings, "onFail.reworkRounds": 1 },
			}),
		).toThrow(/is not a role setting/);
		expect(() =>
			resolveNewProjectKit(catalog, { kit: "team", preset: "cloud", roleSettings: { "roles.dev.agent": "codex" } }),
		).toThrow(/only for a custom team/);
	});

	it("describes a role by agent and model, and what runs without it", () => {
		const base = { defined: true, agentId: null, provider: null, model: null, tier: null } as const;
		expect(describeKitChoiceRole({ ...base, role: "dev", defined: false })).toBe("the selected agent");
		expect(describeKitChoiceRole({ ...base, role: "qa", defined: false })).toBe("none (no QA)");
		expect(describeKitChoiceRole({ ...base, role: "fallback", defined: false })).toBe("none");
		expect(describeKitChoiceRole({ ...base, role: "qa", agentId: "codex" })).toBe("codex, its default model");
		expect(describeKitChoiceRole({ ...base, role: "fallback", model: "m" })).toBe("the dev agent, m");
		expect(
			describeKitChoiceRole({ ...base, role: "dev", agentId: "cline", provider: "lemonade", model: "Muse-GGUF" }),
		).toBe("cline, Muse-GGUF (lemonade)");
		expect(
			describeKitChoiceRole({
				...base,
				role: "dev",
				agentId: "cline",
				provider: "cline-pass",
				model: "cline-pass/glm-5.3",
			}),
		).toBe("cline, cline-pass/glm-5.3");
	});
});
