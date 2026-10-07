import { describe, expect, it } from "vitest";

import { RUNTIME_AGENT_CATALOG } from "../../../src/core/agent-catalog";
import {
	buildRestartResumeLaunch,
	RESTART_RESUME_NOTE,
	RESTART_WIP_NOTE,
} from "../../../src/pipeline/recovery-prompts";

describe("restart resume launch", () => {
	it("keeps the legacy kit's resume note word for word (kit main a2b4695 lib/resume.mjs RESUME_NOTE)", () => {
		expect(RESTART_RESUME_NOTE).toBe(
			"NOTE (orchestrator): you were resumed after a container/Kanban restart that ended your previous session. Pick up where you left off (check git status and git diff if unsure what you already did), finish the card, and end with a STATUS line.",
		);
	});

	it("continues Claude's conversation with the note only, whatever the worktree holds", () => {
		for (const hasWip of [true, false]) {
			expect(buildRestartResumeLaunch("claude", "Do the card.", hasWip)).toEqual({
				prompt: RESTART_RESUME_NOTE,
				continueConversation: true,
			});
		}
	});

	it("starts every other agent fresh with the card prompt, plus the WIP note only with tracked changes", () => {
		for (const { id } of RUNTIME_AGENT_CATALOG.filter((entry) => entry.id !== "claude")) {
			expect(buildRestartResumeLaunch(id, "Do the card.", true)).toEqual({
				prompt: `Do the card.\n\n${RESTART_WIP_NOTE}`,
				continueConversation: false,
			});
			expect(buildRestartResumeLaunch(id, "Do the card.", false)).toEqual({
				prompt: "Do the card.",
				continueConversation: false,
			});
		}
	});
});
