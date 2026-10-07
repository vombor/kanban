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
		// Not installed: no row.
		expect(findings).toHaveLength(6);
	});

	it("reports Codex writes as native where its sandbox runs", async () => {
		const findings = await checkGuardrails(parsePipelineConfig({}).config, deps(["codex"], true));
		expect(findings[1]?.message).toContain("writes native (--sandbox workspace-write");
		expect(findings[1]?.level).toBe("info");
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
