import { describe, expect, it } from "vitest";

import { runtimeBoardCardSchema, runtimeConfigResponseSchema } from "../../src/core/api-contract";

const baseCard = { id: "dev-1", prompt: "Do it", startInPlanMode: false, baseRef: "main", createdAt: 0, updatedAt: 0 };

describe("card role and the qa auto-review mode in the API contract", () => {
	it("accepts the qa mode and every role, and refuses an unknown role", () => {
		expect(runtimeBoardCardSchema.parse({ ...baseCard, autoReviewMode: "qa", role: "calibration" })).toMatchObject({
			autoReviewMode: "qa",
			role: "calibration",
		});
		expect(runtimeBoardCardSchema.parse(baseCard)).not.toHaveProperty("role");
		expect(runtimeBoardCardSchema.safeParse({ ...baseCard, role: "judge" }).success).toBe(false);
		// Legacy mode names still map to commit.
		expect(runtimeBoardCardSchema.parse({ ...baseCard, autoReviewMode: "move_to_done" }).autoReviewMode).toBe(
			"commit",
		);
	});

	it("never accepts qa as an armed git action: the reconciler only types commit and PR prompts", () => {
		const pendingGitAction = { action: "qa", requestedAt: 1, headCommitAtRequest: null, attempt: 0 };
		expect(runtimeBoardCardSchema.safeParse({ ...baseCard, pendingGitAction }).success).toBe(false);
		expect(
			runtimeBoardCardSchema.safeParse({ ...baseCard, pendingGitAction: { ...pendingGitAction, action: "pr" } })
				.success,
		).toBe(true);
	});

	it("has an optional landing mode in the runtime config response", () => {
		const landingMode = runtimeConfigResponseSchema.shape.landingMode;
		expect(landingMode.safeParse(undefined).success).toBe(true);
		expect(landingMode.safeParse("qa").success).toBe(true);
		expect(landingMode.safeParse("auto").success).toBe(false);
	});
});
