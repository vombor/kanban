import { describe, expect, it } from "vitest";

import { runtimeTaskTrashRequestSchema } from "../../../src/core/api-contract";
import { inferLegacyCardRole, isKanbanLandedCard, resolveCardRoleWithSource } from "../../../src/core/card-role";
import { createCard } from "../../utilities/workspace-state-store";

describe("resolveCardRole", () => {
	it("takes the card's own role, whatever its title says", () => {
		expect(resolveCardRoleWithSource({ role: "dev", title: "QA2 d0001: x", prompt: "" })).toEqual({
			role: "dev",
			source: "card",
		});
		expect(resolveCardRoleWithSource({ role: "qa", title: "anything", prompt: "" })).toEqual({
			role: "qa",
			source: "card",
		});
	});

	it("reads the legacy kit's markers only on a role-less card", () => {
		const cases: Array<[{ title?: string; prompt: string }, string | null]> = [
			[{ title: "QA d0001: Add a wishlist", prompt: "" }, "qa"],
			[{ title: "QA3 d0001: Add a wishlist", prompt: "" }, "qa"],
			[{ title: "BENCH QA d0001: x", prompt: "" }, "qa"],
			[{ title: "", prompt: 'You are the QA reviewer (round 2) for Kanban dev card d0001 ("x"), built by…' }, "qa"],
			[{ title: "QA-CAL qa-models-v5 haiku", prompt: "" }, "calibration"],
			[
				{ title: "", prompt: "You are the QA reviewer (calibration qa-models-v5 k1) for a Kanban dev card" },
				"calibration",
			],
			[{ title: "TRIAGE d0001: stalled", prompt: "" }, "triage"],
			[{ title: "", prompt: "You are the Kanban orchestrator's triage agent. review-watch found…" }, "triage"],
			// Dev cards that only mention QA or triage.
			[{ title: "QA gate: verdict ingest", prompt: "" }, null],
			[
				{
					title: "P4-T1 Routing parity",
					prompt: "Write team-qa-routing tests. You are the QA reviewer of nothing.",
				},
				null,
			],
			[{ title: "Triage the flaky test", prompt: "" }, null],
			[{ title: "judge tier2-coupons", prompt: "" }, null],
			[{ prompt: "Fix the cart" }, null],
		];
		for (const [card, role] of cases) {
			expect(inferLegacyCardRole(card), JSON.stringify(card)).toBe(role);
			expect(resolveCardRoleWithSource(card)).toEqual(
				role ? { role, source: "legacy" } : { role: "dev", source: "default" },
			);
		}
	});
});

describe("isKanbanLandedCard", () => {
	it("only landing mode qa dev cards that auto-review doesn't own are landed by Kanban", () => {
		const dev = createCard({ id: "a" });
		expect(isKanbanLandedCard(dev, "qa")).toBe(true);
		expect(isKanbanLandedCard({ ...dev, autoReviewEnabled: true, autoReviewMode: "qa" }, "qa")).toBe(true);
		expect(isKanbanLandedCard({ ...dev, autoReviewEnabled: true, autoReviewMode: "commit" }, "qa")).toBe(false);
		expect(isKanbanLandedCard({ ...dev, role: "triage" }, "qa")).toBe(false);
		expect(isKanbanLandedCard({ ...dev, title: "QA1 b0b0b: check" }, "qa")).toBe(false);
		for (const mode of ["off", "commit", "pr", null, undefined] as const) {
			expect(isKanbanLandedCard(dev, mode)).toBe(false);
		}
	});

	it("a plan card's spec lands like dev work on a landing-mode-qa board (a human's land, never a PASS)", () => {
		const plan = createCard({ id: "p", role: "plan" });
		expect(resolveCardRoleWithSource(plan)).toEqual({ role: "plan", source: "card" });
		expect(isKanbanLandedCard(plan, "qa")).toBe(true);
		expect(isKanbanLandedCard(plan, "off")).toBe(false);
	});
});

describe("Done request schema", () => {
	it("accepts land/discard and the API triggers, never the in-process ones", () => {
		expect(runtimeTaskTrashRequestSchema.parse({ taskId: "a", trigger: "approve", landing: "land" })).toEqual({
			taskId: "a",
			trigger: "approve",
			landing: "land",
		});
		expect(runtimeTaskTrashRequestSchema.safeParse({ taskId: "a", trigger: "hold_release" }).success).toBe(false);
		expect(runtimeTaskTrashRequestSchema.safeParse({ taskId: "a", trigger: "pipeline" }).success).toBe(false);
		expect(runtimeTaskTrashRequestSchema.safeParse({ taskId: "a", landing: "maybe" }).success).toBe(false);
	});
});
