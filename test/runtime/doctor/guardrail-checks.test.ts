import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { checkGuardrails, type GuardrailCheckDeps } from "../../../src/doctor/guardrail-checks";

function deps(installed: string[], sandbox: boolean | null): GuardrailCheckDeps {
	return {
		isInstalled: (binary) => installed.includes(binary),
		sandboxAvailable: async (agentId) => (agentId === "codex" ? sandbox : null),
	};
}

describe("kanban doctor guardrail rows", () => {
	it("has one row per installed agent and says the orchestrator is exempt by design", async () => {
		const findings = await checkGuardrails(
			parsePipelineConfig({}).config,
			deps(["claude", "codex", "cline", "copilot", "gemini"], false),
		);
		expect(findings.every((finding) => finding.area === "guardrails")).toBe(true);
		expect(findings[0]?.message).toContain("the orchestrator is exempt by design");
		const row = (label: string) => findings.find((finding) => finding.message.startsWith(`${label}:`));
		expect(row("Claude Code")?.level).toBe("info");
		expect(row("Claude Code")?.message).toContain("commands native");
		// No bubblewrap: Codex keeps the bypass, so its writes are prompt-only.
		expect(row("OpenAI Codex")?.level).toBe("warn");
		expect(
			findings.find((finding) => finding.message.includes("--dangerously-bypass-approvals-and-sandbox")),
		).toBeDefined();
		expect(findings.find((finding) => finding.message.includes("Kanban's PreToolUse hook"))?.level).toBe("info");
		expect(findings.find((finding) => finding.message.includes("write(<dir>/**)"))?.level).toBe("info");
		expect(findings.find((finding) => finding.message.includes("launch prompt note only"))?.level).toBe("warn");
		// Not installed: no row. Plus the PR and Commit git action rows.
		expect(findings).toHaveLength(8);
	});

	it("reports Codex writes as native where its sandbox runs", async () => {
		const findings = await checkGuardrails(parsePipelineConfig({}).config, deps(["codex"], true));
		expect(findings[1]?.message).toContain("writes native (--sandbox workspace-write");
		expect(findings[1]?.level).toBe("info");
	});

	it("says a PR card may push its own branch only where Kanban's matcher guards the shell", async () => {
		const prRow = (findings: Awaited<ReturnType<typeof checkGuardrails>>) =>
			findings.find((finding) => finding.message.startsWith("PR git action"));
		const matcherOnly = prRow(await checkGuardrails(parsePipelineConfig({}).config, deps(["claude", "cline"], null)));
		expect(matcherOnly?.level).toBe("info");
		expect(matcherOnly?.message).toContain("may push its own branch");
		const withCopilot = prRow(
			await checkGuardrails(parsePipelineConfig({}).config, deps(["claude", "copilot", "codex"], false)),
		);
		expect(withCopilot?.level).toBe("warn");
		expect(withCopilot?.message).toContain("OpenAI Codex");
		expect(withCopilot?.message).toContain("keep the push deny");
		const denied = prRow(
			await checkGuardrails(
				parsePipelineConfig({ guardrails: { prCardPush: "deny" } }).config,
				deps(["claude"], null),
			),
		);
		expect(denied?.level).toBe("warn");
		expect(denied?.message).toContain("no card may push");
		// No push deny configured: nothing to say about PRs.
		expect(
			prRow(
				await checkGuardrails(
					parsePipelineConfig({ guardrails: { denyCommands: ["podman restart"] } }).config,
					deps(["claude"], null),
				),
			),
		).toBeUndefined();
	});

	it("says the Commit action can't resolve conflicts in the base worktree while writes are confined", async () => {
		const commitRow = (config: unknown) =>
			checkGuardrails(parsePipelineConfig(config).config, deps([], null)).then((findings) =>
				findings.find((finding) => finding.message.startsWith("Commit git action")),
			);
		expect((await commitRow({}))?.message).toContain("landing mode qa");
		expect(await commitRow({ guardrails: { confineWrites: false } })).toBeUndefined();
	});

	it("reflects per-workspace overrides", async () => {
		const findings = await checkGuardrails(
			parsePipelineConfig({
				workspaces: {
					off: { name: "Legacy", guardrails: { enabled: false } },
					extra: { guardrails: { extraDenyCommands: ["npm publish"], extraWritableDirs: ["/data"] } },
					plain: {},
				},
			}).config,
			deps(["claude"], null),
		);
		const off = findings.find((finding) => finding.message.startsWith("workspace Legacy (off)"));
		expect(off?.level).toBe("warn");
		expect(off?.message).toContain("workspaces.off.guardrails.enabled: false");
		const extra = findings.find((finding) => finding.message.startsWith("workspace extra"));
		expect(extra?.message).toContain("also denies npm publish");
		expect(extra?.message).toContain("may also write /data");
		expect(findings.some((finding) => finding.message.startsWith("workspace plain"))).toBe(false);
	});

	it("keeps the agent rows when the guardrails are off machine-wide but on for a workspace", async () => {
		const findings = await checkGuardrails(
			parsePipelineConfig({ guardrails: { enabled: false }, workspaces: { ws: { guardrails: { enabled: true } } } })
				.config,
			deps(["claude"], null),
		);
		expect(findings.find((finding) => finding.message.includes("guardrails are off"))?.level).toBe("warn");
		expect(findings.find((finding) => finding.message.startsWith("workspace ws"))?.message).toContain(
			"on although guardrails.enabled is false",
		);
		expect(findings.some((finding) => finding.message.startsWith("Claude Code:"))).toBe(true);
	});

	it("warns when the guardrails are off", async () => {
		const findings = await checkGuardrails(
			parsePipelineConfig({ guardrails: { enabled: false } }).config,
			deps(["copilot"], null),
		);
		expect(findings.map((finding) => finding.level)).toEqual(["info", "warn"]);
		expect(findings[1]?.message).toContain("guardrails are off");
	});
});
