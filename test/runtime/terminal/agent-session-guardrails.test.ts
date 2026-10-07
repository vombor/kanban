import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_GUARDRAIL_DENY_COMMANDS } from "../../../src/config/pipeline-config";
import type { RuntimeAgentId } from "../../../src/core/api-contract";
import { parseDeniedCommandPatterns } from "../../../src/guardrails/command-patterns";
import type { TaskGuardrails } from "../../../src/guardrails/task-guardrails";
import type { AgentAdapterLaunchInput } from "../../../src/terminal/agent-session-adapters";
import { prepareAgentLaunch, removeTaskLaunchFiles } from "../../../src/terminal/agent-session-adapters";
import { evaluateClaudeGuard } from "../../../src/terminal/claude-guard";

const sandboxMocks = vi.hoisted(() => ({ probeCodexSandbox: vi.fn(async () => false) }));

vi.mock("../../../src/terminal/agent-guardrails.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/terminal/agent-guardrails")>()),
	probeCodexSandbox: sandboxMocks.probeCodexSandbox,
}));

const GUARDRAIL_NOTE = "Kanban guardrails for this card:";
const HOME_AGENT_TASK_ID = "__home_agent__:workspace-1:";
const originalHome = process.env.HOME;
let tempHome: string;
let worktree: string;

function createGuardrails(overrides: Partial<TaskGuardrails> = {}): TaskGuardrails {
	return {
		worktreePath: worktree,
		projectPath: "/projects/repo",
		protectedDirs: ["/projects/repo", "/worktrees/card-2/repo"],
		confineWrites: true,
		gitCommonDir: "/projects/repo/.git",
		tempDirs: ["/tmp"],
		linkedDirs: ["/projects/repo/node_modules"],
		extraWritableDirs: [],
		sharedBranches: ["main", "fork/stack"],
		deniedCommands: parseDeniedCommandPatterns(DEFAULT_GUARDRAIL_DENY_COMMANDS, ["main", "fork/stack"]),
		ownBranchPush: false,
		...overrides,
	};
}

function launchInput(
	agentId: RuntimeAgentId,
	overrides: Partial<AgentAdapterLaunchInput> = {},
): AgentAdapterLaunchInput {
	return {
		taskId: "card-1",
		agentId,
		binary: agentId,
		args: [],
		autonomousModeEnabled: true,
		cwd: worktree,
		prompt: "Fix the bug",
		workspaceId: "workspace-1",
		guardrails: createGuardrails(),
		...overrides,
	};
}

/** A home-agent (orchestrator) launch: the runtime resolves no guardrails, and the adapters ignore any anyway. */
function homeAgentInput(agentId: RuntimeAgentId): AgentAdapterLaunchInput {
	return launchInput(agentId, { taskId: `${HOME_AGENT_TASK_ID}${agentId}`, guardrails: createGuardrails() });
}

function valuesOf(args: string[], flag: string): string[] {
	return args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));
}

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-guardrail-adapters-"));
	process.env.HOME = tempHome;
	worktree = mkdtempSync(join(tempHome, "worktree-"));
	sandboxMocks.probeCodexSandbox.mockReset();
	sandboxMocks.probeCodexSandbox.mockResolvedValue(false);
});

afterEach(() => {
	process.env.HOME = originalHome;
	rmSync(tempHome, { recursive: true, force: true });
});

describe("Copilot guardrails at launch", () => {
	it("keeps autopilot's full permissions and adds the deny rules (autonomous)", async () => {
		const launch = await prepareAgentLaunch(launchInput("copilot"));
		// 0aa75: autopilot needs all permissions, or Copilot opens a blocking dialog.
		expect(launch.args).toEqual(
			expect.arrayContaining(["--allow-all-tools", "--allow-all-paths", "--allow-all-urls", "--autopilot"]),
		);
		expect(valuesOf(launch.args, "--deny-tool")).toEqual([
			"shell(git push)",
			"shell(git filter-branch)",
			"shell(git filter-repo)",
			"write(/projects/repo/**)",
			"write(/worktrees/card-2/repo/**)",
		]);
		const prompt = valuesOf(launch.args, "--interactive")[0] ?? "";
		expect(prompt.startsWith("Fix the bug\n\n")).toBe(true);
		expect(prompt).toContain(GUARDRAIL_NOTE);
		expect(prompt).toContain("podman restart|stop|rm|kill");
		await launch.cleanup?.();
	});

	it("adds the deny rules in plan mode, without approval flags", async () => {
		const launch = await prepareAgentLaunch(
			launchInput("copilot", { startInPlanMode: true, args: ["--allow-all", "--yolo"] }),
		);
		expect(launch.args).toContain("--plan");
		expect(launch.args).not.toContain("--allow-all");
		expect(launch.args).not.toContain("--autopilot");
		expect(valuesOf(launch.args, "--deny-tool")).toContain("shell(git push)");
		await launch.cleanup?.();
	});

	it("keeps user-supplied flags and adds its rules next to the user's", async () => {
		const launch = await prepareAgentLaunch(
			launchInput("copilot", { args: ["--allow-all", "--deny-tool", "shell(rm)", "--add-dir", "/data"] }),
		);
		expect(launch.args).toContain("--allow-all");
		expect(launch.args).not.toContain("--allow-all-paths");
		expect(valuesOf(launch.args, "--deny-tool")).toEqual(expect.arrayContaining(["shell(rm)", "shell(git push)"]));
		expect(valuesOf(launch.args, "--add-dir")).toEqual(["/data"]);
		await launch.cleanup?.();
	});

	it("adds the deny rules without autonomy too", async () => {
		const launch = await prepareAgentLaunch(launchInput("copilot", { autonomousModeEnabled: false }));
		expect(launch.args).not.toContain("--allow-all-tools");
		expect(valuesOf(launch.args, "--deny-tool")).toContain("write(/projects/repo/**)");
		await launch.cleanup?.();
	});
});

describe("Codex guardrails at launch", () => {
	it("writes forbidden rules into the worktree and keeps the bypass where Codex's sandbox can't run", async () => {
		const launch = await prepareAgentLaunch(launchInput("codex"));
		const rules = readFileSync(join(worktree, ".codex", "rules", "kanban-guardrails.rules"), "utf8");
		expect(rules).toContain('prefix_rule(pattern=["git", "push"], decision="forbidden"');
		expect(launch.args).toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(launch.args).not.toContain("--sandbox");
		const prompt = launch.args.at(-1) ?? "";
		expect(prompt).toContain(GUARDRAIL_NOTE);
		expect(prompt).toContain("writes outside the worktree");
	});

	it("uses the workspace-write sandbox with the git dir and shared dirs when the sandbox runs", async () => {
		sandboxMocks.probeCodexSandbox.mockResolvedValue(true);
		const launch = await prepareAgentLaunch(launchInput("codex"));
		expect(launch.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(valuesOf(launch.args, "--sandbox")).toEqual(["workspace-write"]);
		expect(valuesOf(launch.args, "--ask-for-approval")).toEqual(["never"]);
		// npm ci and Playwright write their caches under the home.
		expect(valuesOf(launch.args, "--add-dir")).toEqual([
			"/projects/repo/.git",
			"/projects/repo/node_modules",
			join(tempHome, ".npm"),
			join(tempHome, ".cache"),
			join(tempHome, ".pnpm-store"),
			join(tempHome, ".yarn"),
			join(tempHome, ".bun", "install", "cache"),
		]);
		expect(valuesOf(launch.args, "-c")).toContain("sandbox_workspace_write.network_access=true");
		expect(launch.args.at(-1)).not.toContain("writes outside the worktree");
	});

	it("leaves a user-chosen sandbox mode alone and skips the probe", async () => {
		sandboxMocks.probeCodexSandbox.mockResolvedValue(true);
		const launch = await prepareAgentLaunch(launchInput("codex", { args: ["--sandbox", "read-only"] }));
		expect(valuesOf(launch.args, "--sandbox")).toEqual(["read-only"]);
		expect(sandboxMocks.probeCodexSandbox).not.toHaveBeenCalled();
	});

	it("removes a rules file an earlier launch left once guardrails are off, but never a user's file", async () => {
		const rulesPath = join(worktree, ".codex", "rules", "kanban-guardrails.rules");
		await prepareAgentLaunch(launchInput("codex"));
		expect(existsSync(rulesPath)).toBe(true);
		const launch = await prepareAgentLaunch(launchInput("codex", { guardrails: null }));
		expect(existsSync(rulesPath)).toBe(false);
		expect(launch.args).toContain("--dangerously-bypass-approvals-and-sandbox");
		writeFileSync(rulesPath, 'prefix_rule(pattern=["rm"], decision="forbidden")\n');
		await prepareAgentLaunch(launchInput("codex", { guardrails: null }));
		expect(readFileSync(rulesPath, "utf8")).toContain('pattern=["rm"]');
	});

	it("keeps the push deny for a PR card: an argv prefix can't tell its own branch", async () => {
		await prepareAgentLaunch(launchInput("codex", { guardrails: createGuardrails({ ownBranchPush: true }) }));
		const rules = readFileSync(join(worktree, ".codex", "rules", "kanban-guardrails.rules"), "utf8");
		expect(rules).toContain('prefix_rule(pattern=["git", "push"], decision="forbidden"');
	});

	it("keeps the rules in plan mode", async () => {
		const launch = await prepareAgentLaunch(launchInput("codex", { startInPlanMode: true }));
		expect(existsSync(join(worktree, ".codex", "rules", "kanban-guardrails.rules"))).toBe(true);
		expect(launch.deferredStartupInput).toContain("/plan Fix the bug");
		expect(launch.deferredStartupInput).toContain(GUARDRAIL_NOTE);
	});
});

describe("Cline guardrails at launch", () => {
	function readPreToolUseHook(): string {
		return readFileSync(join(worktree, ".cline", "hooks", "PreToolUse"), "utf8");
	}

	it("runs the guard from the PreToolUse hook with the card's policy", async () => {
		const launch = await prepareAgentLaunch(launchInput("cline"));
		expect(valuesOf(launch.args, "--auto-approve")).toEqual(["true"]);
		const hook = readPreToolUseHook();
		expect(hook).toContain("cline-guard");
		expect(hook).toContain("printf '%s\\n' \"$DECISION\"");
		const policyBase64 = /--policy-base64'? '?([A-Za-z0-9+/=]+)/u.exec(hook)?.[1] ?? "";
		const policy = JSON.parse(Buffer.from(policyBase64, "base64").toString("utf8"));
		expect(policy.worktreePath).toBe(worktree);
		expect(policy.writableRoots).toEqual(expect.arrayContaining([worktree, "/projects/repo/.git", "/tmp"]));
		expect(policy.deniedCommands.map((rule: { pattern: string }) => rule.pattern)).toContain("git push");
		expect(launch.args.at(-1)).toContain("shell commands that write outside the worktree");
	});

	it("lets a PR card push its own branch, and says so in the prompt note", async () => {
		const launch = await prepareAgentLaunch(
			launchInput("cline", { guardrails: createGuardrails({ ownBranchPush: true }) }),
		);
		const policyBase64 = /--policy-base64'? '?([A-Za-z0-9+/=]+)/u.exec(readPreToolUseHook())?.[1] ?? "";
		const policy = JSON.parse(Buffer.from(policyBase64, "base64").toString("utf8"));
		const patterns = policy.deniedCommands.map((rule: { pattern: string }) => rule.pattern);
		expect(patterns).toContain("git push {shared-push}");
		expect(patterns).not.toContain("git push");
		expect(launch.args.at(-1)).toContain("pushing your own branch, named explicitly, is fine");
	});

	it("keeps the guard in plan mode", async () => {
		const launch = await prepareAgentLaunch(launchInput("cline", { startInPlanMode: true, args: ["--yolo"] }));
		expect(launch.args).toContain("--plan");
		expect(launch.args).not.toContain("--yolo");
		expect(readPreToolUseHook()).toContain("cline-guard");
	});
});

describe("Claude Code guardrails at launch", () => {
	it("passes a card its own --settings file with the deny rules and no prompt note", async () => {
		const launch = await prepareAgentLaunch(launchInput("claude"));
		const settingsPath = valuesOf(launch.args, "--settings")[0] ?? "";
		expect(settingsPath).toContain(join("hooks", "claude", "cards", "card-1.json"));
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(settings.hooks.Stop).toBeDefined();
		expect(settings.permissions.deny).toEqual(
			expect.arrayContaining(["Bash(git push)", "Bash(git push *)", "Edit(//projects/repo/**)"]),
		);
		expect(valuesOf(launch.args, "--permission-mode")).toEqual(["auto"]);
		expect(launch.args.at(-1)).toBe("Fix the bug");
	});

	it("runs Kanban's matcher from a PreToolUse hook on Bash, ahead of the activity hook", async () => {
		const launch = await prepareAgentLaunch(launchInput("claude"));
		const settings = JSON.parse(readFileSync(valuesOf(launch.args, "--settings")[0] ?? "", "utf8"));
		const [guard, activity] = settings.hooks.PreToolUse;
		expect(guard.matcher).toBe("Bash");
		const command: string = guard.hooks[0].command;
		expect(command).toContain("claude-guard");
		expect(activity.matcher).toBe("*");
		const policyBase64 = /--policy-base64'? '?([A-Za-z0-9+/=]+)/u.exec(command)?.[1] ?? "";
		const policy = JSON.parse(Buffer.from(policyBase64, "base64").toString("utf8"));
		const output = evaluateClaudeGuard({ tool_name: "Bash", tool_input: { command: "sh -c 'git push'" } }, policy);
		expect(output?.hookSpecificOutput.permissionDecision).toBe("deny");
	});

	it("has the guard hook without Kanban's hook context too", async () => {
		const launch = await prepareAgentLaunch(launchInput("claude", { workspaceId: undefined }));
		const settings = JSON.parse(readFileSync(valuesOf(launch.args, "--settings")[0] ?? "", "utf8"));
		expect(settings.hooks.PreToolUse).toHaveLength(1);
		expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("claude-guard");
		expect(settings.hooks.Stop).toBeUndefined();
	});

	it("lets a PR card push its own branch", async () => {
		const launch = await prepareAgentLaunch(
			launchInput("claude", { guardrails: createGuardrails({ ownBranchPush: true }) }),
		);
		const settings = JSON.parse(readFileSync(valuesOf(launch.args, "--settings")[0] ?? "", "utf8"));
		expect(settings.permissions.deny).not.toContain("Bash(git push *)");
		expect(settings.permissions.deny).toEqual(
			expect.arrayContaining(["Bash(git push)", "Bash(git push* main)", "Bash(git push*:fork/stack *)"]),
		);
	});

	it("removes the card's settings file when the card's launch files are cleaned up (Done)", async () => {
		const launch = await prepareAgentLaunch(launchInput("claude"));
		const settingsPath = valuesOf(launch.args, "--settings")[0] ?? "";
		expect(existsSync(settingsPath)).toBe(true);
		await removeTaskLaunchFiles("card-1");
		expect(existsSync(settingsPath)).toBe(false);
		// Nothing to remove: no error.
		await removeTaskLaunchFiles("card-1");
	});
});

describe("agents without a verified mechanism", () => {
	it.each(["gemini", "opencode", "droid", "kiro"] as const)(
		"%s gets the guardrails as a prompt note",
		async (agentId) => {
			const launch = await prepareAgentLaunch(launchInput(agentId));
			expect(launch.args.join("\n")).toContain(GUARDRAIL_NOTE);
			expect(launch.args.join("\n")).toContain("any of them");
		},
	);
});

describe("the orchestrator is exempt", () => {
	it.each(["claude", "codex", "cline", "copilot", "gemini", "opencode", "droid", "kiro"] as const)(
		"a %s home-agent session gets no guardrails",
		async (agentId) => {
			const launch = await prepareAgentLaunch(homeAgentInput(agentId));
			const joined = launch.args.join("\n");
			expect(joined).not.toContain(GUARDRAIL_NOTE);
			expect(launch.args).not.toContain("--deny-tool");
			expect(joined).not.toContain("permissions");
			if (agentId === "codex") {
				expect(launch.args).toContain("--dangerously-bypass-approvals-and-sandbox");
				expect(existsSync(join(worktree, ".codex", "rules", "kanban-guardrails.rules"))).toBe(false);
			}
			if (agentId === "copilot") {
				expect(launch.args).toContain("--allow-all-paths");
			}
			if (agentId === "cline") {
				expect(readFileSync(join(worktree, ".cline", "hooks", "PreToolUse"), "utf8")).not.toContain("cline-guard");
			}
			if (agentId === "claude") {
				const settingsPath = valuesOf(launch.args, "--settings")[0] ?? "";
				expect(settingsPath).not.toContain("cards");
				expect(JSON.parse(readFileSync(settingsPath, "utf8")).permissions).toBeUndefined();
			}
			await launch.cleanup?.();
		},
	);
});
