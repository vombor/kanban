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
		expect(lines.some((line) => line.startsWith("  2) team-cloud (built-in)"))).toBe(true);
	});

	it("takes a number or a name, and default for an empty answer or ended input", async () => {
		const choices = await builtInChoices();
		const byNumber = scripted(["3"]);
		expect(await askProjectKit(choices, byNumber.io)).toBe("team-local");
		expect(byNumber.questions).toEqual(["Kit [1, default]: "]);
		expect(await askProjectKit(choices, scripted(["team-cline"]).io)).toBe("team-cline");
		expect(await askProjectKit(choices, scripted([""]).io)).toBe("default");
		expect(await askProjectKit(choices, scripted([null]).io)).toBe("default");
	});

	it("asks again after an answer that is no listed kit, and gives up after three", async () => {
		const choices = await builtInChoices();
		const retry = scripted(["nope", "99", "2"]);
		expect(await askProjectKit(choices, retry.io)).toBe("team-cloud");
		expect(retry.written.filter((line) => line.includes("is not one of the kits above"))).toHaveLength(2);
		await expect(askProjectKit(choices, scripted(["x", "y", "z"]).io)).rejects.toThrow("No kit chosen.");
	});
});
