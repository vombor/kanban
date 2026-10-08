import { describe, expect, it } from "vitest";

import { checkGitHubAuth, type GitHubAuthCheckDeps } from "../../../src/doctor/github-auth-checks";

function deps(overrides: Partial<GitHubAuthCheckDeps> = {}): GitHubAuthCheckDeps {
	return {
		env: { GH_TOKEN: "pat-value", COPILOT_GITHUB_TOKEN: "copilot-value" },
		isOnPath: () => true,
		isCopilotSignedIn: async () => true,
		...overrides,
	};
}

const PRECEDENCE = "Copilot uses COPILOT_GITHUB_TOKEN when set, else GH_TOKEN/GITHUB_TOKEN, else its own login";

describe("kanban doctor GitHub auth rows", () => {
	it("says the PAT and Copilot's token are set without printing them", async () => {
		const findings = await checkGitHubAuth(deps());
		expect(findings.map((finding) => finding.level)).toEqual(["info", "info"]);
		expect(findings[0]?.message).toContain("GH_TOKEN is set");
		expect(findings[1]?.message).toBe(`${PRECEDENCE}: Copilot cards run on COPILOT_GITHUB_TOKEN`);
		expect(JSON.stringify(findings)).not.toContain("pat-value");
		expect(JSON.stringify(findings)).not.toContain("copilot-value");
	});

	it("needs no Copilot login while COPILOT_GITHUB_TOKEN is set", async () => {
		const findings = await checkGitHubAuth(deps({ isCopilotSignedIn: async () => false }));
		expect(findings.map((finding) => finding.level)).toEqual(["info", "info"]);
	});

	it("uses the login without any token", async () => {
		const findings = await checkGitHubAuth(deps({ env: {} }));
		expect(findings.map((finding) => finding.level)).toEqual(["info", "info"]);
		expect(findings[1]?.message).toBe(`${PRECEDENCE}: Copilot cards run on its own login`);
	});

	it("warns when the PAT would win over Copilot's login", async () => {
		const findings = await checkGitHubAuth(deps({ env: { GH_TOKEN: "pat-value" } }));
		expect(findings[1]?.message).toBe(`${PRECEDENCE}: Copilot cards run on the PAT in GH_TOKEN`);
		expect(findings[2]).toEqual(
			expect.objectContaining({
				level: "warn",
				message: "no COPILOT_GITHUB_TOKEN: Copilot takes the PAT in GH_TOKEN over its own login",
			}),
		);
		expect(JSON.stringify(findings)).not.toContain("pat-value");
	});

	it.each([{ GH_TOKEN: "pat-value" }, {}, { COPILOT_GITHUB_TOKEN: "  " }])(
		"warns without COPILOT_GITHUB_TOKEN and a Copilot login (env %o)",
		async (env) => {
			const findings = await checkGitHubAuth(deps({ env, isCopilotSignedIn: async () => false }));
			const warnings = findings.filter((finding) => finding.level === "warn");
			expect(warnings).toEqual([
				expect.objectContaining({
					message: "no COPILOT_GITHUB_TOKEN and Copilot is not logged in: Copilot cards can't start a run",
				}),
			]);
		},
	);

	it("has no Copilot rows without Copilot, and an info row without a token", async () => {
		const findings = await checkGitHubAuth(deps({ env: {}, isOnPath: () => false }));
		expect(findings).toHaveLength(1);
		expect(findings[0]).toEqual(expect.objectContaining({ level: "info", hint: "docs/fork/github-auth.md" }));
	});
});
