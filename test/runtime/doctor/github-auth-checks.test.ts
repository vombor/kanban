import { describe, expect, it } from "vitest";

import { checkGitHubAuth, type GitHubAuthCheckDeps } from "../../../src/doctor/github-auth-checks";

function deps(overrides: Partial<GitHubAuthCheckDeps> = {}): GitHubAuthCheckDeps {
	return {
		env: { GH_TOKEN: "pat-value" },
		isOnPath: () => true,
		isCopilotSignedIn: async () => true,
		...overrides,
	};
}

describe("kanban doctor GitHub auth rows", () => {
	it("says the PAT is set without printing it, and that Copilot uses its own login", async () => {
		const findings = await checkGitHubAuth(deps());
		expect(findings.map((finding) => finding.level)).toEqual(["info", "info"]);
		expect(findings[0]?.message).toContain("GH_TOKEN is set");
		expect(findings[1]?.message).toContain("Copilot ignores the container PAT");
		expect(JSON.stringify(findings)).not.toContain("pat-value");
	});

	it("warns when Copilot is installed but not logged in", async () => {
		const findings = await checkGitHubAuth(deps({ isCopilotSignedIn: async () => false }));
		expect(findings.find((finding) => finding.level === "warn")).toEqual(
			expect.objectContaining({
				message: "Copilot is not logged in: Copilot cards can't start a run",
				hint: "copilot login",
			}),
		);
	});

	it("has no Copilot rows without Copilot, and an info row without a token", async () => {
		const findings = await checkGitHubAuth(deps({ env: {}, isOnPath: () => false }));
		expect(findings).toHaveLength(1);
		expect(findings[0]).toEqual(expect.objectContaining({ level: "info", hint: "docs/fork/github-auth.md" }));
	});
});
