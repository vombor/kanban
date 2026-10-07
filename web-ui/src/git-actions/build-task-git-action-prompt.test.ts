import { describe, expect, it } from "vitest";

import {
	buildTaskGitActionPrompt,
	buildTaskGitPrPushGuardrailNote,
	TASK_GIT_BASE_REF_PROMPT_VARIABLE,
} from "@/git-actions/build-task-git-action-prompt";

describe("buildTaskGitActionPrompt", () => {
	it("interpolates the shared base ref variable into custom templates", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "commit",
				workspaceInfo: {
					taskId: "task-123",
					path: "/tmp/task-123",
					exists: true,
					baseRef: "main",
					branch: null,
					isDetached: true,
					headCommit: "abc123",
				},
				templates: {
					commitPromptTemplate: `Commit onto ${TASK_GIT_BASE_REF_PROMPT_VARIABLE.token}.`,
				},
			}),
		).toBe("Commit onto main.");
	});

	it("falls back to the default action prompt when no template is configured", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "pr",
				workspaceInfo: {
					taskId: "task-123",
					path: "/tmp/task-123",
					exists: true,
					baseRef: "main",
					branch: null,
					isDetached: true,
					headCommit: "abc123",
				},
			}),
		).toBe(
			`Handle this pull request action using the provided git context.\n\n${buildTaskGitPrPushGuardrailNote("task-123")}`,
		);
	});

	it("tells the agent of a PR action how the user lets a card push when the guardrails block it", () => {
		const prompt = buildTaskGitActionPrompt({
			action: "pr",
			workspaceInfo: {
				taskId: "task-123",
				path: "/tmp/task-123",
				exists: true,
				baseRef: "main",
				branch: "card",
				isDetached: false,
				headCommit: "abc123",
			},
			templates: { openPrPromptTemplate: "Open a PR against {{base_ref}}." },
		});
		expect(prompt.startsWith("Open a PR against main.\n\n")).toBe(true);
		expect(prompt).toContain(
			"set the card's git action to PR (`kanban task update --task-id task-123 --auto-review-mode pr`) and restart its session",
		);
		expect(prompt).toContain("do not try to work around it");
	});
});
