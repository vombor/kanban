import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeKitChoiceRole } from "../../../src/core/kit-choice-display";
import { listKitChoices, resolveNewProjectKitName } from "../../../src/kits/kit-choices";
import { loadKitCatalog } from "../../../src/kits/resolve-kit";
import { createTempDir } from "../../utilities/temp-dir";

function writeUserKit(kitsDir: string, name: string, kit: Record<string, unknown>): void {
	mkdirSync(kitsDir, { recursive: true });
	writeFileSync(join(kitsDir, `${name}.json`), JSON.stringify({ kit: 1, name, ...kit }));
}

describe("kit choices for a new project", () => {
	it("lists default first, then the built-in kits in order, then user kits, each with its four roles", async () => {
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
			expect(choices.kits.map((kit) => kit.name)).toEqual([
				"default",
				"team-cloud",
				"team-local",
				"team-cline",
				"alpha",
				"team-foo",
			]);
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
			const cline = choices.kits.find((kit) => kit.name === "team-cline");
			expect(cline?.roles[0]).toMatchObject({ agentId: "cline", tier: "dev", provider: "cline-pass" });
			expect(cline?.roles[0]?.model).toMatch(/^cline-pass\//);
			expect(choices.errors.map((error) => error.name)).toEqual([join(kitsDir, "broken.json")]);
		} finally {
			cleanup();
		}
	});

	it("takes default for no name and refuses an unknown or renamed kit with the resolver's reason", async () => {
		const catalog = await loadKitCatalog(join(tmpdir(), "kanban-no-user-kits"));
		expect(resolveNewProjectKitName(catalog, undefined)).toBe("default");
		expect(resolveNewProjectKitName(catalog, " ")).toBe("default");
		expect(resolveNewProjectKitName(catalog, "team-local")).toBe("team-local");
		expect(() => resolveNewProjectKitName(catalog, "nope")).toThrow(/unknown kit "nope"/);
		expect(() => resolveNewProjectKitName(catalog, "team")).toThrow(/renamed to team-cloud/);
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
