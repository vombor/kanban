import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { shouldAutoConfirmClaudeWorkspaceTrust } from "../../../src/terminal/claude-workspace-trust";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

describe("shouldAutoConfirmClaudeWorkspaceTrust", () => {
	it("trusts Claude task worktrees in the current and the legacy worktree roots", async () => {
		await withTemporaryKanbanHome(
			(home) => {
				expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", join(home.worktreesRootPath, "abc12", "repo"))).toBe(
					true,
				);
				expect(
					shouldAutoConfirmClaudeWorkspaceTrust(
						"claude",
						join(home.userHomePath, ".cline", "worktrees", "old01", "repo"),
					),
				).toBe(true);
				expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", join(home.userHomePath, "projects", "repo"))).toBe(
					false,
				);
				expect(shouldAutoConfirmClaudeWorkspaceTrust("codex", join(home.worktreesRootPath, "abc12", "repo"))).toBe(
					false,
				);
			},
			{ layout: "initialized" },
		);
	});

	it("keeps trusting ~/.cline/worktrees on the legacy home", async () => {
		await withTemporaryKanbanHome(
			(home) => {
				expect(
					shouldAutoConfirmClaudeWorkspaceTrust(
						"claude",
						join(home.userHomePath, ".cline", "worktrees", "d18bd", "kanban"),
					),
				).toBe(true);
			},
			{ layout: "legacy" },
		);
	});
});
