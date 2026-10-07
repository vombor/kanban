import { describe, expect, it } from "vitest";

import { buildPlanBreakdownExample, buildPlanPrompt, readPlanSlugFromPrompt } from "../../../src/kits/plan-prompt";
import { buildQaRequirements } from "../../../src/pipeline/qa-prompt";
import { parsePlanBreakdown, slugifyPlanTitle } from "../../../src/plans/plan-breakdown";
import { buildPlannedCardPrompt, checkPlanExpandable, planExpansion } from "../../../src/plans/plan-expand";
import type { PlanRecord } from "../../../src/plans/plan-index";

const PROMPT = "Implement the thing in src/thing.ts and test it in test/thing.test.ts.";

function card(id: string, overrides: Record<string, unknown> = {}) {
	return { id, title: `Card ${id}`, prompt: PROMPT, dependsOn: [], acceptanceCriteria: [`${id} works`], ...overrides };
}

function breakdown(cards: unknown[], overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ version: 1, slug: "coupons", cards, ...overrides });
}

function issuesOf(text: string, slug?: string): string[] {
	const parsed = parsePlanBreakdown(text, slug);
	return parsed.ok ? [] : parsed.issues;
}

describe("plan breakdown validation", () => {
	it("accepts a valid breakdown and defaults role and dependsOn", () => {
		const parsed = parsePlanBreakdown(
			breakdown([card("schema", { parallelGroup: "w1" }), { ...card("api"), dependsOn: ["schema"] }]),
			"coupons",
		);
		expect(parsed.ok).toBe(true);
		expect(parsed.ok && parsed.breakdown.cards.map((entry) => [entry.id, entry.role, entry.dependsOn])).toEqual([
			["schema", "dev", []],
			["api", "dev", ["schema"]],
		]);
	});

	it("refuses bad JSON, unknown keys, non-dev roles, missing criteria and an empty or other-slug breakdown", () => {
		expect(issuesOf("{")[0]).toMatch(/^not valid JSON/u);
		expect(issuesOf(breakdown([card("a", { extra: 1 })])).join()).toContain("extra");
		expect(issuesOf(breakdown([card("a", { role: "qa" })])).join()).toContain("cards.0.role");
		expect(issuesOf(breakdown([card("a", { acceptanceCriteria: [] })])).join()).toContain(
			"needs at least one acceptance criterion",
		);
		expect(issuesOf(breakdown([card("a", { prompt: "do it" })])).join()).toContain("too short");
		expect(issuesOf(breakdown([])).join()).toContain("has no cards");
		expect(issuesOf(breakdown([card("a")]), "other")).toEqual([
			'slug: "coupons" is not the plan card\'s slug "other"',
		]);
	});

	it("refuses duplicate ids, unknown or self dependencies, cycles and a dependency inside a parallel group", () => {
		expect(issuesOf(breakdown([card("a"), card("a")]))).toEqual(['cards.1.id: "a" is used by more than one card']);
		expect(issuesOf(breakdown([card("a", { dependsOn: ["zzz"] })]))).toEqual([
			'cards.0.dependsOn.0: "zzz" is not a card of this breakdown',
		]);
		expect(issuesOf(breakdown([card("a", { dependsOn: ["a"] })]))).toEqual([
			"cards.0.dependsOn.0: a card can't depend on itself",
		]);
		expect(
			issuesOf(
				breakdown([
					card("a", { dependsOn: ["c"] }),
					card("b", { dependsOn: ["a"] }),
					card("c", { dependsOn: ["b"] }),
				]),
			),
		).toEqual(["cards: dependency cycle: a -> c -> b -> a"]);
		expect(
			issuesOf(
				breakdown([
					card("a", { parallelGroup: "w1" }),
					card("b", { dependsOn: ["a"] }),
					card("c", { dependsOn: ["b"], parallelGroup: "w1" }),
				]),
			),
		).toEqual(['cards.2.parallelGroup: "c" depends on "a" of its own parallel group "w1"']);
	});

	it("slugifies titles", () => {
		expect(slugifyPlanTitle("Coupons & Gift cards: v2!")).toBe("coupons-gift-cards-v2");
		expect(slugifyPlanTitle("Écran d'accueil")).toBe("ecran-d-accueil");
		expect(slugifyPlanTitle("???")).toBe("plan");
	});
});

describe("plan prompt", () => {
	it("shows a breakdown example that validates", () => {
		expect(parsePlanBreakdown(buildPlanBreakdownExample("coupons"), "coupons").ok).toBe(true);
	});

	it("wraps the requirement: read the codebase, every spec section, the cards file, no card commands, a STATUS line", () => {
		const prompt = buildPlanPrompt({
			requirement: "Customers can redeem coupons at checkout.",
			slug: "coupons",
			rules: ["Specs are in English."],
			startInPlanMode: true,
		});
		expect(prompt).toContain("READ THE CODEBASE");
		for (const section of [
			"Problem",
			"Goals",
			"Non-goals",
			"User-visible behaviour",
			"Design (cite the real files",
			"Risks",
			"Test plan",
			"Rollout / flags",
			"Open questions",
		]) {
			expect(prompt).toContain(`   - ${section}`);
		}
		expect(prompt).toContain("docs/specs/coupons.md");
		expect(prompt).toContain("docs/specs/coupons.cards.json");
		expect(prompt).toContain("sized for ONE agent session");
		expect(prompt).toContain("you do NOT create, start, link or move any card");
		expect(prompt).toContain("You start in plan mode");
		expect(prompt).toContain("- Specs are in English.");
		expect(prompt).toMatch(/Finish with one line: "STATUS: PLAN READY/u);
		expect(prompt.endsWith('"""\nCustomers can redeem coupons at checkout.\n"""')).toBe(true);
		expect(readPlanSlugFromPrompt(prompt)).toBe("coupons");
		expect(buildPlanPrompt({ requirement: "x", slug: "s", rules: [], startInPlanMode: false })).not.toContain(
			"plan mode",
		);
	});
});

describe("expansion", () => {
	it("appends the acceptance criteria before a FINAL STEP, so the QA requirements keep them", () => {
		const prompt = buildPlannedCardPrompt(
			{ prompt: `${PROMPT}\n\nFINAL STEP: reply DONE.`, acceptanceCriteria: ["redeem returns 409 when used"] },
			{ planTaskId: "pln01", specPath: "docs/specs/coupons.md" },
		);
		expect(prompt).toMatch(
			/Acceptance criteria \(from plan card pln01[^\n]*\n- redeem returns 409 when used\n\nFINAL STEP/u,
		);
		const requirements = buildQaRequirements(prompt, "");
		expect(requirements).toContain("- redeem returns 409 when used");
		expect(requirements).not.toContain("FINAL STEP");
	});

	it("chooses task ids up front, reuses an unfinished expand's ids, and links by local id", () => {
		const parsed = parsePlanBreakdown(breakdown([card("a"), card("b", { dependsOn: ["a"] })]));
		if (!parsed.ok) {
			throw new Error(parsed.issues.join());
		}
		let uuid = 0;
		const randomUuid = () => `${String(++uuid).padStart(5, "0")}aaaa-0000-0000-0000-000000000000`;
		const first = planExpansion({
			breakdown: parsed.breakdown,
			planTaskId: "pln01",
			specPath: "docs/specs/coupons.md",
			boardTaskIds: new Set(["pln01"]),
			previous: null,
			randomUuid,
		});
		expect(first.cards.map((entry) => [entry.localId, entry.taskId, entry.exists])).toEqual([
			["a", "00001", false],
			["b", "00002", false],
		]);
		expect(first.links).toEqual([{ waiting: "b", prerequisite: "a" }]);
		const resumed = planExpansion({
			breakdown: parsed.breakdown,
			planTaskId: "pln01",
			specPath: "docs/specs/coupons.md",
			boardTaskIds: new Set(["pln01", "00001"]),
			previous: {
				status: "creating",
				startedAt: "x",
				finishedAt: null,
				breakdownSha256: "s",
				cards: first.taskIds,
				links: first.links,
			},
			randomUuid,
		});
		expect(resumed.cards.map((entry) => [entry.taskId, entry.exists])).toEqual([
			["00001", true],
			["00002", false],
		]);
	});

	it("is allowed only for a plan card in Review that the user approved for exactly this breakdown", () => {
		const record = (overrides: Partial<PlanRecord> = {}): PlanRecord => ({
			taskId: "pln01",
			slug: "coupons",
			title: "Plan",
			createdAt: "2026-10-07T00:00:00.000Z",
			kit: "team",
			agentId: "claude",
			providerId: null,
			modelId: null,
			startInPlanMode: true,
			approval: null,
			expansion: null,
			metrics: null,
			...overrides,
		});
		const base = {
			taskId: "pln01",
			role: "plan",
			column: "review" as const,
			record: record(),
			breakdownSha256: "sha-1",
			approvedByUser: false,
			dryRun: false,
		};
		const approval = { at: "2026-10-07T01:00:00.000Z", via: "approve" as const, breakdownSha256: "sha-1" };
		expect(checkPlanExpandable(base)).toMatchObject({ ok: false, error: expect.stringContaining("not approved") });
		expect(checkPlanExpandable({ ...base, dryRun: true })).toEqual({
			ok: true,
			approval: null,
			needsApproval: false,
		});
		expect(checkPlanExpandable({ ...base, approvedByUser: true })).toEqual({
			ok: true,
			approval: null,
			needsApproval: true,
		});
		expect(checkPlanExpandable({ ...base, record: record({ approval }) })).toEqual({
			ok: true,
			approval,
			needsApproval: false,
		});
		expect(checkPlanExpandable({ ...base, record: record({ approval }), breakdownSha256: "sha-2" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("changed after the user approved it"),
		});
		expect(checkPlanExpandable({ ...base, record: record({ approval }), column: "in_progress" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("only from Review"),
		});
		expect(checkPlanExpandable({ ...base, role: "dev", record: record({ approval }) })).toMatchObject({
			ok: false,
			error: expect.stringContaining("not a plan card"),
		});
		expect(
			checkPlanExpandable({
				...base,
				record: record({
					approval,
					expansion: {
						status: "done",
						startedAt: "a",
						finishedAt: "b",
						breakdownSha256: "sha-1",
						cards: {},
						links: [],
					},
				}),
			}),
		).toMatchObject({ ok: false, error: expect.stringContaining("already expanded") });
	});
});
