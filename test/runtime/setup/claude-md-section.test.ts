// The managed "Kanban on this machine" section of Claude Code's user memory (src/setup/claude-md-section.ts): Kanban
// is developed outside the pod (docs/fork/development.md), so its pod-level jobs are the user's alone.
import { describe, expect, it } from "vitest";

import { renderClaudeMdSection } from "../../../src/setup/claude-md-section";

describe("renderClaudeMdSection", () => {
	it("leaves the pod-level jobs to the user and sends Kanban's own bugs to vombor/kanban issues", () => {
		const section = renderClaudeMdSection();
		expect(section).toContain("Kanban is developed outside this pod");
		expect(section).toContain("(docs/fork/development.md)");
		expect(section).toContain("Never edit Kanban's own repo.");
		expect(section).toContain("The pod-level jobs are the user's alone: `kanban setup-provider`");
		expect(section).toContain("`kanban restart update`");
		expect(section).toContain("the user curates it with models that\n  passed `kanban models vet`");
		expect(section).not.toContain("Kanban project's orchestrator");
	});
});
