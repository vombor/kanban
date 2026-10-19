import { describe, expect, it } from "vitest";
import { DEV_COMPLETION_MARKER, withDevCompletionContract } from "../../../src/kits/dev-completion";
import { getDefaultKit } from "../../../src/kits/resolve-kit";
import { resolveTeamKit } from "../../utilities/team-kits";

describe("team dev Review handoff (#71)", () => {
	for (const preset of ["cloud", "cline", "lemonade"] as const)
		it(`applies the same default contract to ${preset} without changing its workflow or model policy`, () => {
			const kit = resolveTeamKit(preset),
				before = JSON.stringify(kit),
				prompt = "Implement the requested feature and leave existing behavior intact.";
			const prepared = withDevCompletionContract(prompt, kit, { role: "dev", prompt, title: "Dev task" });
			expect(prepared).toContain(DEV_COMPLETION_MARKER);
			expect(prepared).toContain("native completion/end-of-turn mechanism immediately");
			expect(prepared).toContain("Do not launch QA");
			expect(prepared).toContain("Reuse passing verification");
			expect(prepared).toContain("specific QA rework finding");
			expect(prepared).toContain("After context compaction");
			expect(JSON.stringify(kit)).toBe(before);
			expect(withDevCompletionContract(prepared, kit, { role: "dev", prompt })).toBe(prepared);
		});
	it("never applies to QA/planning/triage/calibration, legacy QA markers, sidebar/missing cards or the default kit", () => {
		const kit = resolveTeamKit("lemonade"),
			prompt = "Keep this role's own workflow.";
		for (const role of ["qa", "plan", "triage", "calibration"] as const)
			expect(withDevCompletionContract(prompt, kit, { role, prompt })).toBe(prompt);
		expect(
			withDevCompletionContract(prompt, kit, { prompt: "You are the QA reviewer for Kanban dev card abcde" }),
		).toBe(prompt);
		expect(withDevCompletionContract(prompt, kit, null)).toBe(prompt);
		expect(withDevCompletionContract("", kit, { role: "dev", prompt })).toBe("");
		expect(withDevCompletionContract(prompt, getDefaultKit(), { role: "dev", prompt })).toBe(prompt);
	});
});
