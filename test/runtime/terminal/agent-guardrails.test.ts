import { describe, expect, it } from "vitest";

import { DEFAULT_GUARDRAIL_DENY_COMMANDS } from "../../../src/config/pipeline-config";
import { parseDeniedCommandPatterns } from "../../../src/guardrails/command-patterns";
import type { TaskGuardrails } from "../../../src/guardrails/task-guardrails";
import {
	buildClaudePermissionDeny,
	buildCodexRulesFile,
	buildCopilotDenyTools,
	buildCopilotWriteDenyTools,
	type ClineGuardPolicy,
	describeAgentGuardrails,
} from "../../../src/terminal/agent-guardrails";
import { evaluateClineGuard, listPatchPaths } from "../../../src/terminal/cline-guard";

const rules = parseDeniedCommandPatterns(DEFAULT_GUARDRAIL_DENY_COMMANDS, ["main", "fork/stack"]);

function createGuardrails(overrides: Partial<TaskGuardrails> = {}): TaskGuardrails {
	return {
		worktreePath: "/wt/card-1/repo",
		projectPath: "/projects/repo",
		protectedDirs: ["/projects/repo", "/wt/card-2/repo"],
		confineWrites: true,
		gitCommonDir: "/projects/repo/.git",
		tempDirs: ["/tmp"],
		linkedDirs: ["/projects/repo/node_modules"],
		extraWritableDirs: [],
		sharedBranches: ["main", "fork/stack"],
		deniedCommands: rules,
		...overrides,
	};
}

describe("Copilot guardrails", () => {
	it("denies whole programs and git/gh subcommands, and leaves the rest to the prompt", () => {
		const { denyTools, unenforced } = buildCopilotDenyTools(rules);
		expect(denyTools).toEqual(["shell(git push)", "shell(git filter-branch)", "shell(git filter-repo)"]);
		// `shell(podman restart)` blocks nothing in Copilot 1.0.92, and it has no argument matching.
		expect(unenforced.map((rule) => rule.pattern)).toEqual(
			expect.arrayContaining(["podman restart|stop|rm|kill", "git update-ref {shared}", "kanban home migrate"]),
		);
		expect(buildCopilotDenyTools(parseDeniedCommandPatterns(["gh pr|release", "terraform"], [])).denyTools).toEqual([
			"shell(gh pr)",
			"shell(gh release)",
			"shell(terraform)",
		]);
	});

	it("denies file-tool writes to the main checkout and the other worktrees, unless writes aren't confined", () => {
		expect(buildCopilotWriteDenyTools(createGuardrails())).toEqual([
			"write(/projects/repo/**)",
			"write(/wt/card-2/repo/**)",
		]);
		expect(buildCopilotWriteDenyTools(createGuardrails({ confineWrites: false }))).toEqual([]);
	});
});

describe("Codex guardrails", () => {
	it("writes one forbidden prefix rule per pattern, alternatives as lists", () => {
		const file = buildCodexRulesFile(rules);
		expect(file).toContain(
			'prefix_rule(pattern=["git", "push"], decision="forbidden", justification="Kanban guardrail for task cards: git push")',
		);
		expect(file).toContain(
			'prefix_rule(pattern=["git", "branch", ["-D", "-d", "--delete", "-f", "--force", "-m", "-M"], ["main", "refs/heads/main", "fork/stack", "refs/heads/fork/stack"]], decision="forbidden"',
		);
		expect(file).toContain('prefix_rule(pattern=["systemctl", "--user", ["restart", "stop", "kill"]]');
		// The program position is always one word: one rule per program.
		const split = buildCodexRulesFile(parseDeniedCommandPatterns(["podman|docker rm"], []));
		expect(split).toContain('pattern=["podman", "rm"]');
		expect(split).toContain('pattern=["docker", "rm"]');
	});
});

describe("Claude Code guardrails", () => {
	it("denies each command and its arguments, and file edits in the protected dirs", () => {
		const deny = buildClaudePermissionDeny(createGuardrails());
		expect(deny).toEqual(
			expect.arrayContaining([
				"Bash(git push)",
				"Bash(git push *)",
				"Bash(git update-ref refs/heads/fork/stack *)",
				"Bash(git branch -D main *)",
				"Bash(podman restart *)",
				"Bash(kanban home migrate *)",
				"Edit(//projects/repo/**)",
				"Edit(//wt/card-2/repo/**)",
			]),
		);
		expect(deny.some((entry) => entry.includes("card-1"))).toBe(false);
		expect(
			buildClaudePermissionDeny(createGuardrails({ confineWrites: false })).some((e) => e.startsWith("Edit(")),
		).toBe(false);
	});
});

describe("describeAgentGuardrails", () => {
	it("reports how each agent enforces commands, writes and reads", () => {
		expect(describeAgentGuardrails("claude").commands.level).toBe("native");
		expect(describeAgentGuardrails("claude").unenforced).toEqual([]);

		const codexWithoutSandbox = describeAgentGuardrails("codex", { codexSandbox: false });
		expect(codexWithoutSandbox.writes.level).toBe("prompt");
		expect(codexWithoutSandbox.writes.mechanism).toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(codexWithoutSandbox.unenforced).toContain("writes outside the worktree");
		expect(describeAgentGuardrails("codex", { codexSandbox: true }).writes.level).toBe("native");

		expect(describeAgentGuardrails("cline").commands.level).toBe("native");
		expect(describeAgentGuardrails("cline").writes.level).toBe("partial");

		const copilot = describeAgentGuardrails("copilot", { deniedCommands: rules });
		expect(copilot.commands.level).toBe("partial");
		expect(copilot.writes.level).toBe("partial");
		expect(copilot.writes.mechanism).toContain("autopilot needs all permissions");
		expect(copilot.unenforced.join(" ")).toContain("podman restart|stop|rm|kill");

		for (const agentId of ["gemini", "opencode", "droid", "kiro"] as const) {
			const report = describeAgentGuardrails(agentId);
			expect(report.commands.level, agentId).toBe("prompt");
			expect(report.writes.level, agentId).toBe("prompt");
		}
		for (const agentId of ["claude", "codex", "cline", "copilot", "gemini"] as const) {
			expect(describeAgentGuardrails(agentId).reads.level, agentId).toBe("none");
		}
	});
});

describe("Cline guard", () => {
	const policy: ClineGuardPolicy = {
		worktreePath: "/wt/card-1/repo",
		confineWrites: true,
		writableRoots: ["/wt/card-1/repo", "/projects/repo/.git", "/tmp"],
		deniedCommands: rules,
	};
	const call = (name: string, input: Record<string, unknown>) => ({
		hookName: "tool_call",
		tool_call: { id: "1", name, input },
		preToolUse: { toolName: name, parameters: {} },
	});

	it("cancels denied commands, plain and structured, and lets others run", () => {
		const blocked = evaluateClineGuard(call("run_commands", { commands: ["npm test", "git push --force"] }), policy);
		expect(blocked.cancel).toBe(true);
		expect(blocked.errorMessage).toContain('matches "git push"');
		expect(
			evaluateClineGuard(call("run_commands", { commands: [{ command: "git", args: ["push", "origin"] }] }), policy)
				.cancel,
		).toBe(true);
		expect(evaluateClineGuard(call("run_commands", { commands: ["git rebase fork/stack"] }), policy)).toEqual({
			cancel: false,
		});
		// The string-valued copy in preToolUse.parameters when tool_call is missing.
		expect(
			evaluateClineGuard(
				{ preToolUse: { toolName: "run_commands", parameters: { commands: '["podman restart kanban"]' } } },
				policy,
			).cancel,
		).toBe(true);
	});

	it("cancels file edits outside the worktree and its writable dirs", () => {
		expect(evaluateClineGuard(call("editor", { path: "src/a.ts", new_text: "x" }), policy).cancel).toBe(false);
		expect(evaluateClineGuard(call("editor", { path: "/tmp/scratch.txt", new_text: "x" }), policy).cancel).toBe(
			false,
		);
		const outside = evaluateClineGuard(
			call("editor", { path: "../../../projects/repo/a.ts", new_text: "x" }),
			policy,
		);
		expect(outside.cancel).toBe(true);
		expect(outside.errorMessage).toContain("outside this card's worktree");
		const patch = "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: /projects/repo/b.ts\n*** End Patch";
		expect(listPatchPaths(patch)).toEqual(["src/a.ts", "/projects/repo/b.ts"]);
		expect(evaluateClineGuard(call("apply_patch", { input: patch }), policy).cancel).toBe(true);
		expect(
			evaluateClineGuard(call("editor", { path: "/projects/repo/a.ts" }), { ...policy, confineWrites: false })
				.cancel,
		).toBe(false);
		expect(evaluateClineGuard(call("read_files", { files: ["/etc/hostname"] }), policy).cancel).toBe(false);
		expect(evaluateClineGuard({ nothing: true }, policy)).toEqual({ cancel: false });
	});
});
