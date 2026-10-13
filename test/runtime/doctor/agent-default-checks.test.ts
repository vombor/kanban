import { describe, expect, it } from "vitest";

import { checkAgentDefaults } from "../../../src/doctor/agent-default-checks";

describe("checkAgentDefaults", () => {
	it("says nothing when no agent has a default", () => {
		expect(checkAgentDefaults({})).toEqual([]);
	});

	it("lists every agent's default in one info row", () => {
		const findings = checkAgentDefaults({
			codex: { modelId: "sol", reasoningEffort: "high" },
			cline: { providerId: "lemonade", modelId: "Qwen3-Coder" },
			claude: { reasoningEffort: "max" },
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]?.level).toBe("info");
		expect(findings[0]?.message).toContain("OpenAI Codex: sol (effort high)");
		expect(findings[0]?.message).toContain("Cline: lemonade + Qwen3-Coder");
		expect(findings[0]?.message).toContain("Claude Code: the CLI's own model (effort max)");
	});
});
