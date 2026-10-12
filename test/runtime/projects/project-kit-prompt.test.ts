import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { askProjectKit, formatKitChoices } from "../../../src/commands/project-kit-prompt";
import { listKitChoices } from "../../../src/kits/kit-choices";
import { loadKitCatalog } from "../../../src/kits/resolve-kit";

/** A kits dir that doesn't exist: the built-in kits only. */
const NO_USER_KITS = join(tmpdir(), "kanban-no-user-kits");

async function builtInChoices() {
	return listKitChoices(await loadKitCatalog(NO_USER_KITS));
}

function scripted(answers: Array<string | null>) {
	const written: string[] = [];
	const questions: string[] = [];
	return {
		written,
		questions,
		io: {
			ask: async (question: string) => {
				questions.push(question);
				return answers.length > 0 ? (answers.shift() ?? null) : null;
			},
			write: (line: string) => written.push(line),
		},
	};
}

describe("the project kit prompt", () => {
	it("lists every kit numbered with its description and roles, default marked", async () => {
		const lines = formatKitChoices(await builtInChoices());
		expect(lines[1]).toBe("  1) default (built-in) [default]");
		expect(lines).toContain(
			"       dev: the selected agent · qa: none (no QA) · plan: the selected agent · fallback: none",
		);
		expect(lines.some((line) => line.startsWith("  2) team (built-in)"))).toBe(true);
		expect(lines).toContain("       models: a preset (cloud, cline, lemonade), asked next");
	});

	it("takes a number or a name, then the team kit's preset, and default for an empty answer or ended input", async () => {
		const choices = await builtInChoices();
		const byNumber = scripted(["2", "3"]);
		expect(await askProjectKit(choices, byNumber.io)).toEqual({ name: "team", preset: "lemonade", roleSettings: {} });
		expect(byNumber.questions).toEqual(["Kit [1, default]: ", "Preset: "]);
		expect(byNumber.written).toContain(
			"Models for the team kit (the fallback starts without asking, so a paid fallback model runs and costs without approval):",
		);
		expect(byNumber.written.some((line) => line.includes("--kit team --custom --set roles.dev.agent="))).toBe(true);
		expect(await askProjectKit(choices, scripted(["team", "cline"]).io)).toEqual({
			name: "team",
			preset: "cline",
			roleSettings: {},
		});
		const none = { name: "default", preset: null, roleSettings: {} };
		expect(await askProjectKit(choices, scripted([""]).io)).toEqual(none);
		expect(await askProjectKit(choices, scripted([null]).io)).toEqual(none);
	});

	it("asks again after an answer that is no listed kit, and gives up after three", async () => {
		const choices = await builtInChoices();
		const retry = scripted(["nope", "99", "2", "custom", "1"]);
		expect(await askProjectKit(choices, retry.io)).toEqual({ name: "team", preset: "cloud", roleSettings: {} });
		expect(retry.written.filter((line) => line.includes("is not one of the kits above"))).toHaveLength(2);
		expect(retry.written.filter((line) => line.includes("is not one of the presets above"))).toHaveLength(1);
		await expect(askProjectKit(choices, scripted(["x", "y", "z"]).io)).rejects.toThrow("No kit chosen.");
		await expect(askProjectKit(choices, scripted(["2", "x", "y", "z"]).io)).rejects.toThrow("No preset chosen.");
	});
});
