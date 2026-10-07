import { describe, expect, it } from "vitest";

import { inferLegacyCardRole, resolveCardRoleWithSource } from "../../../src/core/card-role";

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
