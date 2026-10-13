import { describe, expect, it } from "vitest";

import { getHeadlessOrchestratorCommand } from "../../../src/terminal/orchestrator-agents";

describe("getHeadlessOrchestratorCommand", () => {
	it("passes no model flags without settings (the CLI's own config)", () => {
		expect(getHeadlessOrchestratorCommand("claude", "go")?.args).toEqual([
			"-p",
			"go",
			"--permission-mode",
			"auto",
			"--output-format",
			"text",
		]);
		expect(getHeadlessOrchestratorCommand("codex", "go")?.args).toEqual([
			"exec",
			"--dangerously-bypass-approvals-and-sandbox",
			"go",
		]);
	});

	it("passes the agent's default model and effort with each CLI's own flags", () => {
		expect(
			getHeadlessOrchestratorCommand("claude", "go", { modelId: "opus", reasoningEffort: "high" })?.args,
		).toEqual([
			"-p",
			"go",
			"--permission-mode",
			"auto",
			"--output-format",
			"text",
			"--model",
			"opus",
			"--effort",
			"high",
		]);
		expect(getHeadlessOrchestratorCommand("codex", "go", { modelId: "sol", reasoningEffort: "high" })?.args).toEqual([
			"exec",
			"--dangerously-bypass-approvals-and-sandbox",
			"-m",
			"sol",
			"-c",
			"model_reasoning_effort=high",
			"go",
		]);
	});

	it("has no headless runner for agents without one", () => {
		expect(getHeadlessOrchestratorCommand("cline", "go", { modelId: "x" })).toBeNull();
	});
});
