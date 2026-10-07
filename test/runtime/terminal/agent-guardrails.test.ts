import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_GUARDRAIL_DENY_COMMANDS } from "../../../src/config/pipeline-config";
import { allowOwnBranchPush, parseDeniedCommandPatterns } from "../../../src/guardrails/command-patterns";
import type { TaskGuardrails } from "../../../src/guardrails/task-guardrails";
import {
	buildClaudePermissionDeny,
	buildCodexRulesFile,
	buildCopilotDenyTools,
	buildCopilotWriteDenyTools,
	type ClineGuardPolicy,
	describeAgentGuardrails,
	listCodexWritableDirs,
	listRuleSlotOrders,
	probeCodexSandboxResult,
} from "../../../src/terminal/agent-guardrails";
import { evaluateClaudeGuard } from "../../../src/terminal/claude-guard";
import { evaluateClineGuard, isWritablePath, listPatchPaths } from "../../../src/terminal/cline-guard";

const rules = parseDeniedCommandPatterns(DEFAULT_GUARDRAIL_DENY_COMMANDS, ["main", "fork/stack"]);

/**
 * A Claude Code Bash rule as documented (code.claude.com/docs/en/permissions, "Wildcard patterns"): `*` matches any
 * text, spaces included; a trailing ` *` that is the rule's only wildcard also matches the bare command.
 */
function claudeRuleMatches(rule: string, command: string): boolean {
	const body = /^Bash\((.*)\)$/su.exec(rule)?.[1];
	if (body === undefined) {
		return false;
	}
	const escapeRegExp = (text: string) => text.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
	const onlyTrailing = body.endsWith(" *") && body.indexOf("*") === body.length - 1;
	const source = onlyTrailing
		? `${escapeRegExp(body.slice(0, -2))}(?: .*)?`
		: body.split("*").map(escapeRegExp).join(".*");
	return new RegExp(`^${source}$`, "su").test(command);
}

function claudeDenies(deny: readonly string[], command: string): boolean {
	return deny.some((rule) => claudeRuleMatches(rule, command));
}

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
		ownBranchPush: false,
		...overrides,
	};
}

describe("Copilot guardrails", () => {
	it("denies whole programs and git/gh subcommands, and leaves the rest to the prompt", () => {
		const { denyTools, unenforced } = buildCopilotDenyTools(rules);
		expect(denyTools).toEqual(["shell(git push)", "shell(git filter-branch)", "shell(git filter-repo)"]);
		// `shell(podman restart)` blocks nothing in Copilot 1.0.92, and it has no argument matching.
		expect(unenforced.map((rule) => rule.pattern)).toEqual(
			expect.arrayContaining([
				"podman restart|stop|rm|kill",
				"git update-ref {shared}",
				"kanban home migrate",
				// `shell(git fetch)` would deny every fetch.
				"git fetch {shared-dest}",
				"git pull {shared-dest}",
			]),
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
		// A prefix rule for `git fetch {shared-dest}` would forbid every fetch; the prompt note carries it.
		expect(file).not.toContain('"fetch"');
		expect(file).not.toContain('"pull"');
		expect(describeAgentGuardrails("codex", { deniedCommands: rules }).unenforced).toContainEqual(
			"commands: git fetch {shared-dest}; git pull {shared-dest}",
		);
		// Each order of the floating slots: `git branch main -D` too.
		expect(file).toContain(
			'prefix_rule(pattern=["git", "branch", ["main", "refs/heads/main", "fork/stack", "refs/heads/fork/stack"], ["-D", "-d", "--delete", "-f", "--force", "-m", "-M"]], decision="forbidden"',
		);
		const branchRule = rules.find((rule) => rule.pattern.startsWith("git branch"));
		expect(branchRule ? listRuleSlotOrders(branchRule) : []).toHaveLength(2);
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
				"Bash(git -* push)",
				"Bash(git -* push *)",
				"Bash(git update-ref* refs/heads/fork/stack *)",
				"Bash(git branch* -D* main *)",
				"Bash(git branch* main* -D)",
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

describe("Claude Code deny rules against the documented rule syntax", () => {
	const deny = buildClaudePermissionDeny(createGuardrails());

	it("covers git's global options before the subcommand and {shared} anywhere after it", () => {
		for (const command of [
			"git push",
			"git push origin card",
			"git -C /projects/kanban push",
			"git -C /projects/kanban push origin main",
			"git -c push.default=current push origin main",
			"git --git-dir=/projects/repo/.git push",
			"git --git-dir /projects/repo/.git --work-tree /projects/repo push origin x",
			"git -C /projects/repo branch -f main X",
			"git branch -q -D main",
			"git branch --force fork/stack HEAD~2",
			"git update-ref -m msg refs/heads/main X",
			"git update-ref --no-deref refs/heads/main",
			"git update-ref -d refs/heads/fork/stack",
			"git -C /projects/repo update-ref refs/heads/main HEAD",
			"git switch --quiet -C fork/stack",
			"git checkout -B main",
			"podman restart kanban",
			"systemctl --user stop kanban",
		]) {
			expect(claudeDenies(deny, command), command).toBe(true);
		}
		for (const command of [
			"git status",
			"git commit -m 'git push later'",
			"git rebase fork/stack",
			"git branch -D card-branch",
			"git branch -f card-branch HEAD~1",
			"git update-ref refs/heads/card HEAD",
			"git checkout fork/stack -- src/file.ts",
			"git fetch origin fork/stack",
			"podman ps",
		]) {
			expect(claudeDenies(deny, command), command).toBe(false);
		}
	});

	it("denies fetches into a shared branch and keeps plain fetches allowed", () => {
		for (const command of [
			"git fetch . card:main",
			"git fetch origin main:main",
			"git fetch origin +main:refs/heads/fork/stack",
			"git fetch origin card:heads/main --quiet",
			"git -C /wt/card fetch origin main:main",
			"git pull origin main:main",
		]) {
			expect(claudeDenies(deny, command), command).toBe(true);
		}
		for (const command of ["git fetch origin main", "git fetch origin main:card", "git pull origin main"]) {
			expect(claudeDenies(deny, command), command).toBe(false);
		}
	});

	it("lets a PR card push its own branch and denies shared or unnamed targets", () => {
		const prDeny = buildClaudePermissionDeny(createGuardrails({ ownBranchPush: true }));
		const prRules = allowOwnBranchPush(rules, ["main", "fork/stack"]);
		const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
		expect(prDeny).not.toContain("Bash(git push *)");
		for (const command of [
			"git push -u origin card-1234",
			"git push origin HEAD:kanban/card",
			"git push -f origin card",
		]) {
			expect(claudeDenies(prDeny, command), command).toBe(false);
		}
		for (const command of [
			"git push",
			"git push -u origin HEAD",
			"git push origin main",
			"git push origin +fork/stack",
			"git push origin HEAD:main",
			"git push origin card:refs/heads/fork/stack",
			"git push origin card:heads/main",
			"git push origin HEAD:heads/fork/stack",
			"git push origin heads/main",
			"git -C /projects/kanban push origin main",
			"git push --all origin",
		]) {
			expect(claudeDenies(prDeny, command), command).toBe(true);
			expect(
				evaluateClaudeGuard(bash(command), { deniedCommands: prRules })?.hookSpecificOutput.permissionDecision,
			).toBe("deny");
		}
		// The rest of the rules don't change.
		expect(claudeDenies(prDeny, "git branch -q -D main")).toBe(true);
	});
});

describe("Claude Code guard hook", () => {
	const bash = (command: string) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

	it("denies with the matcher what the deny rules can't see, and says nothing otherwise", () => {
		for (const command of ["git 'push'", "/usr/bin/git push", "sh -c 'git push'", "timeout 30 git -C /x push"]) {
			const output = evaluateClaudeGuard(bash(command), { deniedCommands: rules });
			expect(output?.hookSpecificOutput.permissionDecision, command).toBe("deny");
			expect(output?.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		}
		expect(evaluateClaudeGuard(bash("npm test"), { deniedCommands: rules })).toBeNull();
		expect(
			evaluateClaudeGuard({ tool_name: "Edit", tool_input: { file_path: "/x" } }, { deniedCommands: rules }),
		).toBeNull();
		expect(evaluateClaudeGuard(null, { deniedCommands: rules })).toBeNull();
	});
});

describe("Codex sandbox probe", () => {
	it("keeps a timed-out probe for a short while only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanban-codex-probe-"));
		try {
			// A stand-in for a hanging `codex sandbox` that logs each run.
			const binary = join(dir, "codex");
			const runs = join(dir, "runs");
			writeFileSync(binary, `#!/bin/sh\necho run >> '${runs}'\nexec sleep 5\n`);
			chmodSync(binary, 0o755);
			let now = 1_000_000;
			const options = { timeoutMs: 200, timeoutCacheMs: 600_000, now: () => now };
			const countRuns = () => readFileSync(runs, "utf8").trim().split("\n").length;
			expect(await probeCodexSandboxResult(binary, options)).toBeNull();
			expect(countRuns()).toBe(1);
			// The next launches within the TTL get the timeout without probing again.
			now += 599_000;
			const startedAt = Date.now();
			expect(await probeCodexSandboxResult(binary, options)).toBeNull();
			expect(Date.now() - startedAt).toBeLessThan(150);
			expect(countRuns()).toBe(1);
			// After it, the next caller probes again.
			now += 2_000;
			expect(await probeCodexSandboxResult(binary, options)).toBeNull();
			expect(countRuns()).toBe(2);
			// A caller that would wait longer than the probe that timed out doesn't take its answer.
			expect(await probeCodexSandboxResult(binary, { ...options, timeoutMs: 300 })).toBeNull();
			expect(countRuns()).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("caps the probe and re-probes after a timeout for a caller that waits longer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanban-codex-probe-"));
		try {
			// A stand-in for `codex sandbox`: hangs on its first run, succeeds afterwards.
			const binary = join(dir, "codex");
			const marker = join(dir, "ran-once");
			writeFileSync(binary, `#!/bin/sh\nif [ -e '${marker}' ]; then exit 0; fi\ntouch '${marker}'\nexec sleep 5\n`);
			chmodSync(binary, 0o755);
			expect(await probeCodexSandboxResult(binary, { timeoutMs: 200 })).toBeNull();
			expect(await probeCodexSandboxResult(binary, { timeoutMs: 2_000 })).toBe(true);
			// Settled: cached for the process.
			rmSync(marker);
			expect(await probeCodexSandboxResult(binary, { timeoutMs: 200 })).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Codex writable dirs", () => {
	it("adds the tool caches npm ci and Playwright write under the home", () => {
		expect(listCodexWritableDirs(createGuardrails(), "/home/u")).toEqual([
			"/projects/repo/.git",
			"/projects/repo/node_modules",
			"/home/u/.npm",
			"/home/u/.cache",
			"/home/u/.pnpm-store",
			"/home/u/.yarn",
			"/home/u/.bun/install/cache",
		]);
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
		expect(evaluateClineGuard(call("run_commands", { commands: ["git fetch . card:main"] }), policy).cancel).toBe(
			true,
		);
		expect(evaluateClineGuard(call("run_commands", { commands: ["git fetch origin main"] }), policy).cancel).toBe(
			false,
		);
		const prPolicy = { ...policy, deniedCommands: allowOwnBranchPush(rules, ["main", "fork/stack"]) };
		expect(
			evaluateClineGuard(call("run_commands", { commands: ["git push origin card:heads/main"] }), prPolicy).cancel,
		).toBe(true);
		expect(evaluateClineGuard(call("run_commands", { commands: ["git push origin card"] }), prPolicy).cancel).toBe(
			false,
		);
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

	it("lets a PR card push its own branch only when its policy says so", () => {
		const prPolicy = { ...policy, deniedCommands: parseDeniedCommandPatterns(["git push {shared-push}"], ["main"]) };
		expect(evaluateClineGuard(call("run_commands", { commands: ["git push -u origin card"] }), prPolicy).cancel).toBe(
			false,
		);
		const blocked = evaluateClineGuard(call("run_commands", { commands: ["git push origin HEAD:main"] }), prPolicy);
		expect(blocked.cancel).toBe(true);
		expect(blocked.errorMessage).toContain("This card may push only its own branch");
	});

	it("decides on where a write really lands, matching each root as given and as resolved", () => {
		const base = mkdtempSync(join(tmpdir(), "kanban-cline-guard-"));
		try {
			const project = join(base, "real", "project");
			const worktree = join(base, "real", "worktree");
			mkdirSync(join(project, "src"), { recursive: true });
			mkdirSync(worktree, { recursive: true });
			// A symlinked parent (`/projects` → `/mnt/projects`) and a link in the worktree into the main checkout.
			symlinkSync(join(base, "real"), join(base, "alias"));
			symlinkSync(project, join(worktree, "escape"));
			const roots = [join(base, "alias", "worktree")];
			expect(isWritablePath(join(worktree, "new-dir", "a.ts"), roots)).toBe(true);
			expect(isWritablePath(join(base, "alias", "worktree", "a.ts"), [worktree])).toBe(true);
			expect(isWritablePath(join(worktree, "escape", "src", "a.ts"), roots)).toBe(false);
			expect(isWritablePath(join(base, "alias", "project", "a.ts"), roots)).toBe(false);
			const guarded = evaluateClineGuard(call("editor", { path: "escape/src/a.ts", new_text: "x" }), {
				...policy,
				worktreePath: worktree,
				writableRoots: [worktree],
			});
			expect(guarded.cancel).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
