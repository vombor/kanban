import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildTaskAgentSettingsForUpdate } from "../../../src/commands/task";
import { CLINE_RULE_FILES } from "../../../src/prompts/cline-rules";
import { getKanbanHomePath } from "../../../src/state/kanban-home";
import { parseCopilotConfig, prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";
import { resolveHookRuntimeContext } from "../../../src/terminal/hook-runtime-context";
import { createGitTestEnv } from "../../utilities/git-env";

const originalHome = process.env.HOME;
const originalAppData = process.env.APPDATA;
const originalLocalAppData = process.env.LOCALAPPDATA;
let tempHome: string | null = null;
const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const originalExecPath = process.execPath;

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-agent-adapters-"));
	process.env.HOME = tempHome;
	return tempHome;
}

function setKanbanProcessContext(): void {
	process.argv = ["node", "/Users/example/repo/dist/cli.js"];
	process.execArgv = [];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: "/usr/local/bin/node",
	});
}

function getCodexConfigOverrideValues(args: string[], key: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "-c" || arg === "--config") {
			const next = args[index + 1];
			if (typeof next === "string" && next.startsWith(`${key}=`)) {
				values.push(next.slice(key.length + 1));
			}
			index += 1;
			continue;
		}
		if (arg.startsWith(`-c${key}=`)) {
			values.push(arg.slice(key.length + 3));
			continue;
		}
		if (arg.startsWith(`--config=${key}=`)) {
			values.push(arg.slice(key.length + 10));
		}
	}
	return values;
}

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
	if (originalAppData === undefined) {
		delete process.env.APPDATA;
	} else {
		process.env.APPDATA = originalAppData;
	}
	if (originalLocalAppData === undefined) {
		delete process.env.LOCALAPPDATA;
	} else {
		process.env.LOCALAPPDATA = originalLocalAppData;
	}
	process.argv = [...originalArgv];
	process.execArgv = [...originalExecArgv];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: originalExecPath,
	});
});

describe("prepareAgentLaunch hook strategies", () => {
	it("configures Codex hooks without legacy notify", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const launchCommand = [launch.binary ?? "", ...launch.args].join(" ");
		expect(launchCommand).toContain("codex");
		expect(launchCommand).toContain("codex-hook");
		expect(launchCommand).toContain("hooks.UserPromptSubmit");
		expect(launchCommand).toContain("hooks.Stop");
		expect(launchCommand).toContain("hooks.PermissionRequest");
		expect(getCodexConfigOverrideValues(launch.args, "features.hooks")).toEqual(["true"]);
		expect(getCodexConfigOverrideValues(launch.args, "features.codex_hooks")).toEqual([]);
		const hookTrustState = getCodexConfigOverrideValues(launch.args, "hooks.state");
		expect(hookTrustState).toHaveLength(1);
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:user_prompt_submit:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:stop:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:permission_request:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:pre_tool_use:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:post_tool_use:0:0"');
		expect(hookTrustState[0]).toContain('trusted_hash="sha256:');
		expect(launchCommand).toContain("timeout=5");
		expect(launchCommand).not.toContain("codex-wrapper");
		expect(launchCommand).not.toContain("notify=");

		const wrapperPath = join(getKanbanHomePath(), "hooks", "codex", "codex-wrapper.mjs");
		expect(existsSync(wrapperPath)).toBe(false);
	});

	it("appends Kanban sidebar instructions for home Claude sessions", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const appendPromptIndex = launch.args.indexOf("--append-system-prompt");
		expect(appendPromptIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[appendPromptIndex + 1]).toContain("Kanban sidebar agent");
		expect(launch.args[appendPromptIndex + 1]).toContain(
			"'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create",
		);
	});

	it("appends Kanban sidebar instructions for home Codex sessions", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const developerInstructions = getCodexConfigOverrideValues(launch.args, "developer_instructions");
		expect(developerInstructions).toHaveLength(1);
		expect(developerInstructions[0]).toContain("Kanban sidebar agent");
		expect(developerInstructions[0]).toContain("'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create");
		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);
	});

	it("disables Codex startup update checks for Kanban-launched sessions", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-updates",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);
	});

	it("preserves an explicit Codex update-check override", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-custom-update-check",
			agentId: "codex",
			binary: "codex",
			args: ["-c", "check_for_update_on_startup=true"],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["true"]);
	});

	it("writes Claude settings with explicit permission hook", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const settingsPath = join(getKanbanHomePath(), "hooks", "claude", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, unknown>;
		};
		expect(settings.hooks?.PermissionRequest).toBeDefined();
		expect(settings.hooks?.PreToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUseFailure).toBeDefined();
	});

	it("writes Gemini settings with AfterTool mapped to to_in_progress", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const settingsPath = join(getKanbanHomePath(), "hooks", "gemini", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
		};
		const afterToolCommand = settings.hooks?.AfterTool?.[0]?.hooks?.[0]?.command;
		expect(afterToolCommand).toContain("hooks");
		expect(afterToolCommand).toContain("gemini-hook");
		const hookScriptPath = join(getKanbanHomePath(), "hooks", "gemini", "gemini-hook.mjs");
		expect(existsSync(hookScriptPath)).toBe(false);
	});

	it("writes OpenCode plugin with root-session filtering and permission hooks", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const pluginPath = join(getKanbanHomePath(), "hooks", "opencode", "kanban.js");
		const plugin = readFileSync(pluginPath, "utf8");
		expect(plugin).toContain("parentID");
		expect(plugin).toContain('"permission.ask"');
		expect(plugin).toContain('"tool.execute.before"');
		expect(plugin).toContain('"tool.execute.after"');
		expect(plugin).toContain("session.status");
		expect(plugin).toContain("message.part.updated");
		expect(plugin).toContain("last_assistant_message");
		expect(plugin).toContain("--metadata-base64");
		expect(plugin).toContain('if (kind === "review")');
		expect(plugin).toContain('currentState = "idle"');
	});

	it("loads OpenCode preferred model from LOCALAPPDATA state and auth paths", async () => {
		const homePath = setupTempHome();
		const localAppDataPath = join(homePath, "AppData", "Local");
		process.env.LOCALAPPDATA = localAppDataPath;

		const statePath = join(localAppDataPath, "opencode", "state");
		mkdirSync(statePath, { recursive: true });
		writeFileSync(
			join(statePath, "model.json"),
			JSON.stringify(
				{
					recent: [
						{ providerID: "anthropic", modelID: "claude-3-7-sonnet" },
						{ providerID: "openai", modelID: "gpt-4o" },
					],
				},
				null,
				2,
			),
			"utf8",
		);

		const authPath = join(localAppDataPath, "opencode");
		mkdirSync(authPath, { recursive: true });
		writeFileSync(
			join(authPath, "auth.json"),
			JSON.stringify(
				{
					openai: { key: "sk-test" },
				},
				null,
				2,
			),
			"utf8",
		);

		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-model",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const modelIndex = launch.args.indexOf("--model");
		expect(modelIndex).toBeGreaterThan(-1);
		expect(launch.args[modelIndex + 1]).toBe("openai/gpt-4o");
	});

	it("writes Droid settings with hook transitions and runtime autonomy mode", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "droid",
			binary: "droid",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const settingsArgIndex = launch.args.indexOf("--settings");
		expect(settingsArgIndex).toBeGreaterThanOrEqual(0);
		const settingsPath = launch.args[settingsArgIndex + 1];
		expect(settingsPath).toBeDefined();

		const settings = JSON.parse(readFileSync(settingsPath ?? "", "utf8")) as {
			autonomyMode?: string;
			hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
		};
		expect(settings.autonomyMode).toBe("auto-high");
		expect(settings.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.Notification?.[0]?.hooks?.[0]?.command).toContain("activity");
		expect(settings.hooks?.Notification?.[1]?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.PreToolUse?.[0]?.matcher).toBe("*");
		expect(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toContain("activity");
		const preToolInProgressHook = settings.hooks?.PreToolUse?.find(
			(hook) => hook.matcher === "Read|Grep|Glob|FetchUrl|WebSearch|Execute|Task|Edit|Create",
		);
		expect(preToolInProgressHook?.hooks?.[0]?.command).toContain("to_in_progress");
		const preToolReviewHook = settings.hooks?.PreToolUse?.find((hook) => hook.matcher === "AskUser");
		expect(preToolReviewHook?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.PostToolUse?.[0]?.matcher).toBe("*");
		expect(settings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toContain("activity");
		const postToolInProgressHook = settings.hooks?.PostToolUse?.find((hook) => hook.matcher === "AskUser");
		expect(postToolInProgressHook?.hooks?.[0]?.command).toContain("to_in_progress");
		expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toContain("to_in_progress");
	});

	it("writes Kiro agent hooks and uses a Kanban-managed soft planning prompt", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-kiro-1",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "Investigate deployment drift",
			startInPlanMode: true,
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-kiro-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");
		expect(launch.args).toContain("--agent");
		expect(launch.args[launch.args.indexOf("--agent") + 1]).toBe("kanban");
		expect(launch.args).toContain("--trust-all-tools");
		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Do not modify files");
		expect(initialPrompt).toContain("Task:\nInvestigate deployment drift");

		const configPath = join(homedir(), ".kiro", "agents", "kanban.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as {
			tools?: string[];
			hooks?: Record<string, Array<{ command?: string }>>;
		};
		expect(config.tools).toEqual(["*"]);
		expect(config.hooks?.agentSpawn?.[0]?.command).toContain("to_in_progress");
		expect(config.hooks?.userPromptSubmit?.[0]?.command).toContain("to_in_progress");
		expect(config.hooks?.preToolUse?.[0]?.command).toContain("activity");
		expect(config.hooks?.preToolUse?.[1]?.command).toContain("to_in_progress");
		expect(config.hooks?.postToolUse?.[0]?.command).toContain("activity");
		expect(config.hooks?.stop?.[0]?.command).toContain("to_review");
		expect(config.hooks?.stop?.[0]?.command).toContain("Waiting for review");
	});

	it("materializes task images for CLI prompts", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-images",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Inspect the attached design",
			images: [
				{
					id: "img-1",
					data: Buffer.from("hello").toString("base64"),
					mimeType: "image/png",
					name: "diagram.png",
				},
			],
		});

		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Attached reference images:");
		expect(initialPrompt).toContain("Task:\nInspect the attached design");

		const imagePathMatch = initialPrompt.match(/1\. (.+?) \(diagram\.png\)/);
		expect(imagePathMatch?.[1]).toBeDefined();
		const imagePath = imagePathMatch?.[1] ?? "";
		expect(existsSync(imagePath)).toBe(true);
		expect(readFileSync(imagePath).toString("utf8")).toBe("hello");
	});

	it("defers Codex plan-mode startup input until startup UI is ready", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Audit the deployment pipeline",
			startInPlanMode: true,
		});

		expect(launch.args).not.toContain("Audit the deployment pipeline");
		expect(launch.deferredStartupInput).toContain("\u001b[200~");
		expect(launch.deferredStartupInput).toContain("/plan Audit the deployment pipeline");
		expect(launch.deferredStartupInput?.endsWith("\r")).toBe(true);
	});

	it("defers a bare /plan command when Codex plan mode has no prompt text", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan-empty",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});

		expect(launch.deferredStartupInput).toContain("/plan");
		expect(launch.deferredStartupInput).not.toContain("/plan ");
		expect(launch.deferredStartupInput?.endsWith("\r")).toBe(true);
	});

	it("adds resume flags for each agent", async () => {
		setupTempHome();

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(codexLaunch.args).toEqual(expect.arrayContaining(["resume", "--last"]));

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(claudeLaunch.args).toContain("--continue");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(geminiLaunch.args).toEqual(expect.arrayContaining(["--resume", "latest"]));

		const opencodeLaunch = await prepareAgentLaunch({
			taskId: "task-opencode",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(opencodeLaunch.args).toContain("--continue");

		const droidLaunch = await prepareAgentLaunch({
			taskId: "task-droid",
			agentId: "droid",
			binary: "droid",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(droidLaunch.args).toContain("--resume");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(kiroLaunch.args).toContain("--resume");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		// Cline has no --continue; a trash-restore relaunches with the original prompt.
		expect(clineLaunch.args).not.toContain("--continue");
	});

	it("places Codex hook config before the resume subcommand", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-resume-hooks",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
			workspaceId: "workspace-1",
		});

		const resumeIndex = launch.args.indexOf("resume");
		expect(resumeIndex).toBeGreaterThan(0);
		for (const key of [
			"features.hooks",
			"hooks.state",
			"hooks.UserPromptSubmit",
			"hooks.Stop",
			"hooks.PermissionRequest",
			"hooks.PreToolUse",
			"hooks.PostToolUse",
		]) {
			const configIndex = launch.args.findIndex((arg) => arg.startsWith(`${key}=`));
			expect(configIndex).toBeGreaterThan(-1);
			expect(configIndex).toBeLessThan(resumeIndex);
		}
	});

	it("applies autonomous mode flags in adapters for non-droid CLIs", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-auto",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		const permissionModeIndex = claudeLaunch.args.indexOf("--permission-mode");
		expect(permissionModeIndex).toBeGreaterThan(-1);
		expect(claudeLaunch.args[permissionModeIndex + 1]).toBe("auto");
		expect(claudeLaunch.args).not.toContain("--dangerously-skip-permissions");
		expect(claudeLaunch.env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe("1");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-auto",
			agentId: "codex",
			binary: "codex",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini-auto",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(geminiLaunch.args).toContain("--yolo");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro-auto",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(kiroLaunch.args).toContain("--trust-all-tools");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline-auto",
			agentId: "cline",
			binary: "cline",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(clineLaunch.args).toEqual(expect.arrayContaining(["--auto-approve", "true"]));
	});

	it("does not add a Claude permission mode when args already set one", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-explicit-mode",
			agentId: "claude",
			binary: "claude",
			args: ["--permission-mode", "acceptEdits"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(launch.args.filter((arg) => arg === "--permission-mode")).toHaveLength(1);
		expect(launch.args).not.toContain("auto");
	});

	it("starts Claude plan mode without bypass flags and keeps auto mode reachable", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-plan",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});
		const permissionModeIndex = launch.args.indexOf("--permission-mode");
		expect(permissionModeIndex).toBeGreaterThan(-1);
		expect(launch.args[permissionModeIndex + 1]).toBe("plan");
		expect(launch.args).not.toContain("--dangerously-skip-permissions");
		expect(launch.args).not.toContain("--allow-dangerously-skip-permissions");
		expect(launch.env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe("1");
	});

	it("strips an explicit Claude bypass arg in plan mode", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-plan-bypass",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});
		expect(launch.args).not.toContain("--dangerously-skip-permissions");
		expect(launch.args).not.toContain("--allow-dangerously-skip-permissions");
		const permissionModeIndex = launch.args.indexOf("--permission-mode");
		expect(launch.args[permissionModeIndex + 1]).toBe("plan");
	});

	it("preserves explicit autonomous args when autonomous mode is disabled", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-no-auto",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(claudeLaunch.args).toContain("--dangerously-skip-permissions");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-no-auto",
			agentId: "codex",
			binary: "codex",
			args: ["--dangerously-bypass-approvals-and-sandbox"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini-no-auto",
			agentId: "gemini",
			binary: "gemini",
			args: ["--yolo"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(geminiLaunch.args).toContain("--yolo");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline-no-auto",
			agentId: "cline",
			binary: "cline",
			args: ["--auto-approve", "true"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(clineLaunch.args).toEqual(expect.arrayContaining(["--auto-approve", "true"]));
		expect(clineLaunch.args).not.toContain("false");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro-no-auto",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat", "--trust-all-tools"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(kiroLaunch.args).toContain("--trust-all-tools");
	});
});

describe("per-task agentSettings overrides", () => {
	const SENTINEL = {
		providerId: "acme-provider",
		modelId: "not-a-real-model-xyz",
		reasoningEffort: "MAXIMUM_OVERDRIVE",
	};

	it("claude: passes model/effort verbatim as --model/--effort", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSettings: { modelId: SENTINEL.modelId, reasoningEffort: SENTINEL.reasoningEffort },
		});

		const modelIndex = launch.args.indexOf("--model");
		expect(modelIndex).toBeGreaterThan(-1);
		expect(launch.args[modelIndex + 1]).toBe(SENTINEL.modelId);
		const effortIndex = launch.args.indexOf("--effort");
		expect(effortIndex).toBeGreaterThan(-1);
		expect(launch.args[effortIndex + 1]).toBe(SENTINEL.reasoningEffort);
	});

	it("claude: keeps an existing --model arg and does not duplicate", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: ["--model", "user-pinned-model"],
			cwd: "/tmp",
			prompt: "",
			agentSettings: { modelId: SENTINEL.modelId, reasoningEffort: SENTINEL.reasoningEffort },
		});

		expect(launch.args.filter((arg) => arg === "--model")).toHaveLength(1);
		expect(launch.args).toContain("user-pinned-model");
		expect(launch.args).not.toContain(SENTINEL.modelId);
		expect(launch.args).toContain("--effort");
	});

	it("codex: model via -m and effort via -c model_reasoning_effort=", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSettings: { modelId: SENTINEL.modelId, reasoningEffort: SENTINEL.reasoningEffort },
		});

		const modelIndex = launch.args.indexOf("-m");
		expect(modelIndex).toBeGreaterThan(-1);
		expect(launch.args[modelIndex + 1]).toBe(SENTINEL.modelId);
		expect(getCodexConfigOverrideValues(launch.args, "model_reasoning_effort")).toEqual([SENTINEL.reasoningEffort]);
	});

	it("codex: does not duplicate when -m or model_reasoning_effort is already set", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: ["-m", "user-pinned-model", "-c", "model_reasoning_effort=user-effort"],
			cwd: "/tmp",
			prompt: "",
			agentSettings: { modelId: SENTINEL.modelId, reasoningEffort: SENTINEL.reasoningEffort },
		});

		expect(launch.args.filter((arg) => arg === "-m")).toHaveLength(1);
		expect(launch.args).toContain("user-pinned-model");
		expect(getCodexConfigOverrideValues(launch.args, "model_reasoning_effort")).toEqual(["user-effort"]);
	});

	it("droid: long-form --model and --reasoning-effort only (no -r)", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "droid",
			binary: "droid",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSettings: { modelId: SENTINEL.modelId, reasoningEffort: SENTINEL.reasoningEffort },
		});

		const modelIndex = launch.args.indexOf("--model");
		expect(modelIndex).toBeGreaterThan(-1);
		expect(launch.args[modelIndex + 1]).toBe(SENTINEL.modelId);
		const effortIndex = launch.args.indexOf("--reasoning-effort");
		expect(effortIndex).toBeGreaterThan(-1);
		expect(launch.args[effortIndex + 1]).toBe(SENTINEL.reasoningEffort);
		expect(launch.args).not.toContain("-r");
	});

	it("gemini: model via -m only; effort has no flag and is not injected", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSettings: { modelId: SENTINEL.modelId, reasoningEffort: SENTINEL.reasoningEffort },
		});

		const modelIndex = launch.args.indexOf("-m");
		expect(modelIndex).toBeGreaterThan(-1);
		expect(launch.args[modelIndex + 1]).toBe(SENTINEL.modelId);
		expect(launch.args).not.toContain(SENTINEL.reasoningEffort);
	});

	it("opencode: composes provider/model when both set; unprefixed when only modelId", async () => {
		setupTempHome();
		const withProvider = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSettings: { providerId: "openrouter", modelId: "acme-model" },
		});
		const modelFlag = withProvider.args.indexOf("--model");
		expect(modelFlag).toBeGreaterThan(-1);
		expect(withProvider.args[modelFlag + 1]).toBe("openrouter/acme-model");

		const withoutProvider = await prepareAgentLaunch({
			taskId: "task-2",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSettings: { modelId: "acme-model" },
		});
		const bareFlag = withoutProvider.args.indexOf("--model");
		expect(bareFlag).toBeGreaterThan(-1);
		expect(withoutProvider.args[bareFlag + 1]).toBe("acme-model");
	});

	it("opencode: task model wins over config-derived preferred model", async () => {
		setupTempHome();
		const stateDir = join(tempHome ?? "", ".local", "state", "opencode");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "model.json"),
			JSON.stringify({ recent: [{ providerID: "openrouter", modelID: "config-preferred-model" }] }),
		);

		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSettings: { modelId: "task-pinned-model" },
		});

		expect(launch.args.filter((arg) => arg === "--model")).toHaveLength(1);
		const modelFlag = launch.args.indexOf("--model");
		expect(launch.args[modelFlag + 1]).toBe("task-pinned-model");
	});

	it("omits --model after task update --model default clears the card setting", async () => {
		const cleared = buildTaskAgentSettingsForUpdate({ modelId: SENTINEL.modelId }, { modelId: null });
		expect(cleared).toBeNull();

		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSettings: cleared ?? undefined,
		});

		expect(launch.args).not.toContain("--model");
	});

	it("cline: passes provider/model/effort verbatim as --provider/--model/--thinking", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSettings: {
				providerId: SENTINEL.providerId,
				modelId: SENTINEL.modelId,
				reasoningEffort: SENTINEL.reasoningEffort,
			},
		});

		const providerIndex = launch.args.indexOf("--provider");
		expect(providerIndex).toBeGreaterThan(-1);
		expect(launch.args[providerIndex + 1]).toBe(SENTINEL.providerId);
		const modelIndex = launch.args.indexOf("--model");
		expect(modelIndex).toBeGreaterThan(-1);
		expect(launch.args[modelIndex + 1]).toBe(SENTINEL.modelId);
		const effortIndex = launch.args.indexOf("--thinking");
		expect(effortIndex).toBeGreaterThan(-1);
		expect(launch.args[effortIndex + 1]).toBe(SENTINEL.reasoningEffort);
	});

	it("cline: keeps user-pinned flags and does not duplicate overrides", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: ["-m", "user-pinned-model", "--thinking", "high"],
			cwd: "/tmp",
			prompt: "",
			agentSettings: { modelId: SENTINEL.modelId, reasoningEffort: SENTINEL.reasoningEffort },
		});

		expect(launch.args.filter((arg) => arg === "-m" || arg === "--model")).toHaveLength(1);
		expect(launch.args).toContain("user-pinned-model");
		expect(launch.args).not.toContain(SENTINEL.modelId);
		expect(launch.args.filter((arg) => arg === "--thinking")).toHaveLength(1);
		expect(launch.args).not.toContain(SENTINEL.reasoningEffort);
	});

	it("kiro: emits a visible session warning when settings are present; none when absent", async () => {
		setupTempHome();
		const withSettings = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "kiro",
			binary: "kiro-cli",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSettings: { modelId: SENTINEL.modelId },
		});
		expect(withSettings.sessionWarning).toBeDefined();
		expect(withSettings.sessionWarning).toContain("kiro");

		const withoutSettings = await prepareAgentLaunch({
			taskId: "task-2",
			agentId: "kiro",
			binary: "kiro-cli",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});
		expect(withoutSettings.sessionWarning).toBeUndefined();
	});
});

describe("cline adapter", () => {
	function setupTaskCwd(): string {
		const home = setupTempHome();
		const taskCwd = join(home, "worktree");
		mkdirSync(taskCwd, { recursive: true });
		return taskCwd;
	}

	function clineCliHookPath(taskCwd: string, hookName: string): string {
		const fileName = process.platform === "win32" ? `${hookName}.ps1` : hookName;
		return join(taskCwd, ".cline", "hooks", fileName);
	}

	it("writes Cline hook scripts into the worktree .cline/hooks directory", async () => {
		const taskCwd = setupTaskCwd();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: taskCwd,
			prompt: "Ship the feature",
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");
		expect(launch.args).not.toContain("--hooks-dir");

		const hookNames = [
			"TaskStart",
			"TaskResume",
			"TaskCancel",
			"TaskComplete",
			"TaskError",
			"PreToolUse",
			"PostToolUse",
			"UserPromptSubmit",
		];
		for (const hookName of hookNames) {
			const hookPath = clineCliHookPath(taskCwd, hookName);
			expect(existsSync(hookPath)).toBe(true);
			const script = readFileSync(hookPath, "utf8");
			expect(script).toContain("kanban-managed: cline-cli hook");
			expect(script).toContain("'--source' 'cline-cli'");
			expect(script).toContain(`'--hook-event-name' '${hookName}'`);
			expect(script).toContain('{"cancel":false}');
		}

		expect(readFileSync(clineCliHookPath(taskCwd, "TaskComplete"), "utf8")).toContain("to_review");
		expect(readFileSync(clineCliHookPath(taskCwd, "TaskComplete"), "utf8")).toContain("Waiting for review");
		expect(readFileSync(clineCliHookPath(taskCwd, "TaskError"), "utf8")).toContain("to_review");
		expect(readFileSync(clineCliHookPath(taskCwd, "TaskCancel"), "utf8")).toContain("to_review");
		expect(readFileSync(clineCliHookPath(taskCwd, "UserPromptSubmit"), "utf8")).toContain("to_in_progress");
		expect(readFileSync(clineCliHookPath(taskCwd, "TaskStart"), "utf8")).toContain("to_in_progress");

		const preToolUseScript = readFileSync(clineCliHookPath(taskCwd, "PreToolUse"), "utf8");
		expect(preToolUseScript).toContain("activity");
		expect(preToolUseScript).toContain("to_review");
		expect(preToolUseScript).toContain("to_in_progress");
		expect(preToolUseScript).toContain("ask_followup_question");
		expect(preToolUseScript).toContain("ask_question");
		expect(preToolUseScript).toContain("submit_and_exit");

		const postToolUseScript = readFileSync(clineCliHookPath(taskCwd, "PostToolUse"), "utf8");
		expect(postToolUseScript).toContain("activity");
		expect(postToolUseScript).toContain("to_in_progress");
		expect(postToolUseScript).toContain("ask_followup_question");
	});

	it("never overwrites user-owned Cline hook files and surfaces a session warning", async () => {
		const taskCwd = setupTaskCwd();
		const userHookPath = clineCliHookPath(taskCwd, "TaskComplete");
		mkdirSync(join(taskCwd, ".cline", "hooks"), { recursive: true });
		writeFileSync(userHookPath, "#!/usr/bin/env bash\necho user-owned\n", "utf8");

		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: taskCwd,
			prompt: "Ship the feature",
			workspaceId: "workspace-1",
		});

		expect(readFileSync(userHookPath, "utf8")).toBe("#!/usr/bin/env bash\necho user-owned\n");
		expect(launch.sessionWarning).toBeDefined();
		expect(launch.sessionWarning).toContain("TaskComplete");
		// Other hooks still install normally.
		expect(existsSync(clineCliHookPath(taskCwd, "UserPromptSubmit"))).toBe(true);
	});

	it("refreshes stale Kanban-managed Cline hook files", async () => {
		const taskCwd = setupTaskCwd();
		const hookPath = clineCliHookPath(taskCwd, "TaskComplete");
		mkdirSync(join(taskCwd, ".cline", "hooks"), { recursive: true });
		writeFileSync(hookPath, "# kanban-managed: cline-cli hook (TaskComplete)\n# stale\n", "utf8");

		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: taskCwd,
			prompt: "Ship the feature",
			workspaceId: "workspace-1",
		});

		const script = readFileSync(hookPath, "utf8");
		expect(script).toContain("to_review");
		expect(script).not.toContain("# stale");
	});

	// Kanban writes nothing under ~/.cline (user rule, 2026-10-07): the rules are workspace rules, the notices are off.
	it("gives every Cline launch Kanban's rules as git-excluded worktree rules and writes nothing under ~/.cline", async () => {
		const taskCwd = setupTaskCwd();
		execFileSync("git", ["init", "-q"], { cwd: taskCwd, env: createGitTestEnv() });
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: taskCwd,
			prompt: "Ship the feature",
			workspaceId: "workspace-1",
		});

		expect(launch.env.CLINE_DISABLE_CLINE_PASS_NOTICE).toBe("1");
		for (const [name, content] of Object.entries(CLINE_RULE_FILES)) {
			const rule = readFileSync(join(taskCwd, ".cline", "rules", `kanban-${name}`), "utf8");
			expect(rule).toBe(`<!-- kanban-managed: cline rule -->\n${content}`);
		}
		const exclude = readFileSync(join(taskCwd, ".git", "info", "exclude"), "utf8");
		expect(exclude).toContain("/.cline/rules/kanban-status-line.md");
		const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
			cwd: taskCwd,
			env: createGitTestEnv(),
			encoding: "utf8",
		});
		expect(status).toBe("");
		expect(existsSync(join(tempHome ?? "", ".cline"))).toBe(false);
	});

	it("never overwrites a user-owned rule file of the same name", async () => {
		const taskCwd = setupTaskCwd();
		const userRule = join(taskCwd, ".cline", "rules", "kanban-keep-acting.md");
		mkdirSync(join(taskCwd, ".cline", "rules"), { recursive: true });
		writeFileSync(userRule, "my own rule\n", "utf8");

		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: taskCwd,
			prompt: "Ship the feature",
			workspaceId: "workspace-1",
		});

		expect(readFileSync(userRule, "utf8")).toBe("my own rule\n");
		expect(launch.sessionWarning).toContain("keep-acting.md");
		expect(existsSync(join(taskCwd, ".cline", "rules", "kanban-status-line.md"))).toBe(true);
	});

	// Foo 27549 (10/07): Cline's hub daemon runs every card's .cline/hooks scripts with its own env, which is the
	// env of the card that started it. The QA card's TaskStart hook then reported to_in_progress for the finished
	// dev card, and session sync moved that card from Review back to In Progress.
	it.skipIf(process.platform === "win32")(
		"reports hooks for the card whose worktree they are in, not the card in the hub daemon's env",
		async () => {
			const home = setupTempHome();
			const qaCwd = join(home, "worktrees", "qa-card");
			mkdirSync(qaCwd, { recursive: true });
			const recordPath = join(home, "hook-calls.jsonl");
			const recorderPath = join(home, "kanban-recorder.cjs");
			writeFileSync(
				recorderPath,
				`require("node:fs").appendFileSync(process.env.HOOK_RECORD, JSON.stringify({ argv: process.argv.slice(2), env: { KANBAN_HOOK_TASK_ID: process.env.KANBAN_HOOK_TASK_ID, KANBAN_HOOK_WORKSPACE_ID: process.env.KANBAN_HOOK_WORKSPACE_ID } }) + "\\n");\n`,
				"utf8",
			);
			process.argv = [originalExecPath, recorderPath];
			process.execArgv = [];

			await prepareAgentLaunch({
				taskId: "qa-card",
				agentId: "cline",
				binary: "cline",
				args: [],
				cwd: qaCwd,
				prompt: "QA the dev card",
				workspaceId: "foo",
			});

			const daemonEnv = {
				...process.env,
				HOOK_RECORD: recordPath,
				KANBAN_HOOK_TASK_ID: "dev-card",
				KANBAN_HOOK_WORKSPACE_ID: "foo",
			};
			for (const hookName of ["TaskStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "TaskComplete"]) {
				execFileSync("bash", [clineCliHookPath(qaCwd, hookName)], {
					cwd: qaCwd,
					env: daemonEnv,
					input: JSON.stringify({ hookName, toolName: "ask_followup_question" }),
				});
			}

			const calls = readFileSync(recordPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { argv: string[]; env: NodeJS.ProcessEnv });
			expect(calls.length).toBeGreaterThanOrEqual(5);
			for (const call of calls) {
				expect(call.argv.slice(0, 2)).toEqual(["hooks", "notify"]);
				const flag = (name: string) => {
					const index = call.argv.indexOf(name);
					return index === -1 ? undefined : call.argv[index + 1];
				};
				expect(call.env.KANBAN_HOOK_TASK_ID).toBe("dev-card");
				expect(
					resolveHookRuntimeContext({ taskId: flag("--task-id"), workspaceId: flag("--workspace-id") }, call.env),
				).toEqual({ taskId: "qa-card", workspaceId: "foo" });
			}
		},
	);

	it("forces the interactive TUI when launching with a prompt", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "Ship the feature",
		});

		expect(launch.args).toContain("--tui");
		expect(launch.args[launch.args.length - 1]).toBe("Ship the feature");
	});

	it("respects an explicit output mode instead of forcing the TUI", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: ["--json"],
			cwd: "/tmp",
			prompt: "Ship the feature",
		});

		expect(launch.args).not.toContain("--tui");
		expect(launch.args).toContain("--json");
	});

	it("applies --auto-approve true in autonomous mode and never passes --yolo", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});

		const flagIndex = launch.args.indexOf("--auto-approve");
		expect(flagIndex).toBeGreaterThan(-1);
		expect(launch.args[flagIndex + 1]).toBe("true");
		expect(launch.args).not.toContain("--yolo");
		expect(launch.args).not.toContain("-y");
	});

	it("passes --auto-approve false when autonomous mode is disabled", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});

		const flagIndex = launch.args.indexOf("--auto-approve");
		expect(flagIndex).toBeGreaterThan(-1);
		expect(launch.args[flagIndex + 1]).toBe("false");
	});

	it("keeps a user-provided --auto-approve value", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: ["--auto-approve", "false"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});

		expect(launch.args.filter((arg) => arg === "--auto-approve")).toHaveLength(1);
		expect(launch.args[launch.args.indexOf("--auto-approve") + 1]).toBe("false");
	});

	it("starts plan mode without approval-bypass flags", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: ["--auto-approve", "true"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "Ship the feature",
			startInPlanMode: true,
		});

		expect(launch.args).toContain("--plan");
		expect(launch.args).not.toContain("--auto-approve");
		expect(launch.args).not.toContain("--yolo");
	});

	it("strips detaching and non-session flags", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: ["--worktree", "--zen", "--kanban", "--update"],
			cwd: "/tmp",
			prompt: "Ship the feature",
		});

		expect(launch.args).not.toContain("--worktree");
		expect(launch.args).not.toContain("--zen");
		expect(launch.args).not.toContain("--kanban");
		expect(launch.args).not.toContain("--update");
	});

	it("does not add a resume flag on trash restore", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "Ship the feature",
			resumeFromTrash: true,
		});

		expect(launch.args).not.toContain("--continue");
		expect(launch.args).not.toContain("--id");
		expect(launch.args).toContain("--tui");
	});

	it("writes home-agent sidebar instructions as a project rules file instead of replacing the system prompt", async () => {
		const home = setupTempHome();
		const taskCwd = join(home, "workspace");
		mkdirSync(taskCwd, { recursive: true });
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:cline-cli",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: taskCwd,
			prompt: "",
		});

		expect(launch.args).not.toContain("--system");
		expect(launch.args).not.toContain("-s");
		const rulesPath = join(taskCwd, ".cline", "rules", "kanban-home-agent.md");
		expect(existsSync(rulesPath)).toBe(true);
		const rules = readFileSync(rulesPath, "utf8");
		expect(rules).toContain("Kanban sidebar agent");
		expect(rules).toContain("'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create");
	});
});

describe("prepareAgentLaunch copilot", () => {
	function copilotInput(overrides: Record<string, unknown> = {}) {
		const cwd = join(tempHome as string, "worktree");
		mkdirSync(cwd, { recursive: true });
		return {
			taskId: "task-copilot",
			agentId: "copilot" as const,
			binary: "copilot",
			args: [],
			cwd,
			prompt: "Build it",
			...overrides,
		};
	}

	it("starts interactive with the prompt and maps the card's model and effort", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch(
			copilotInput({ agentSettings: { modelId: "claude-sonnet-5", reasoningEffort: "high" } }),
		);
		expect(launch.args).toContain("--interactive");
		expect(launch.args[launch.args.indexOf("--interactive") + 1]).toBe("Build it");
		expect(launch.args[launch.args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
		expect(launch.args[launch.args.indexOf("--reasoning-effort") + 1]).toBe("high");
		expect(launch.args).not.toContain("--allow-all-tools");
	});

	it("allows tools and paths and starts autopilot only in autonomous mode, never in plan mode", async () => {
		setupTempHome();
		const autonomous = await prepareAgentLaunch(copilotInput({ autonomousModeEnabled: true }));
		expect(autonomous.args).toEqual(
			expect.arrayContaining(["--allow-all-tools", "--allow-all-paths", "--allow-all-urls", "--autopilot"]),
		);
		expect(autonomous.args).not.toContain("--max-autopilot-continues");

		const allowAll = await prepareAgentLaunch(copilotInput({ autonomousModeEnabled: true, args: ["--allow-all"] }));
		expect(allowAll.args).toContain("--autopilot");
		expect(allowAll.args).not.toContain("--allow-all-urls");

		const plan = await prepareAgentLaunch(
			copilotInput({ autonomousModeEnabled: true, startInPlanMode: true, args: ["--allow-all"] }),
		);
		expect(plan.args).toContain("--plan");
		expect(plan.args).not.toContain("--allow-all");
		expect(plan.args).not.toContain("--allow-all-tools");
		expect(plan.args).not.toContain("--autopilot");

		const interactive = await prepareAgentLaunch(copilotInput());
		expect(interactive.args).not.toContain("--autopilot");
	});

	it("leaves a user-supplied --mode, --autopilot or --max-autopilot-continues alone in autonomous mode", async () => {
		setupTempHome();
		const withMode = await prepareAgentLaunch(
			copilotInput({ autonomousModeEnabled: true, args: ["--mode", "interactive"] }),
		);
		expect(withMode.args).not.toContain("--autopilot");
		expect(withMode.args[withMode.args.indexOf("--mode") + 1]).toBe("interactive");

		const withModeEquals = await prepareAgentLaunch(
			copilotInput({ autonomousModeEnabled: true, args: ["--mode=plan"] }),
		);
		expect(withModeEquals.args).not.toContain("--autopilot");

		const withAutopilot = await prepareAgentLaunch(
			copilotInput({ autonomousModeEnabled: true, args: ["--autopilot", "--max-autopilot-continues", "2"] }),
		);
		expect(withAutopilot.args.filter((arg) => arg === "--autopilot")).toHaveLength(1);
		expect(withAutopilot.args.filter((arg) => arg === "--max-autopilot-continues")).toHaveLength(1);
		expect(withAutopilot.args[withAutopilot.args.indexOf("--max-autopilot-continues") + 1]).toBe("2");
	});

	it("uses the Copilot subscription for provider 'github' and keeps BYOK env empty", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch(
			copilotInput({ agentSettings: { providerId: "github", modelId: "gpt-6.1-sol" } }),
		);
		expect(Object.keys(launch.env).filter((key) => key.startsWith("COPILOT_PROVIDER_"))).toEqual([]);
		expect(launch.sessionWarning).toBeUndefined();
	});

	it("maps a named BYOK profile to COPILOT_PROVIDER_* env without storing secrets", async () => {
		const home = setupTempHome();
		mkdirSync(join(home, ".kanban"), { recursive: true });
		writeFileSync(
			join(home, ".kanban", "copilot-providers.json"),
			JSON.stringify({
				providers: {
					local: { baseUrl: "http://127.0.0.1:13305/v1", type: "openai", apiKeyEnv: "TEST_COPILOT_KEY" },
				},
			}),
		);
		process.env.TEST_COPILOT_KEY = "test-value";
		try {
			const launch = await prepareAgentLaunch(
				copilotInput({ agentSettings: { providerId: "local", modelId: "some-model" } }),
			);
			expect(launch.env.COPILOT_PROVIDER_BASE_URL).toBe("http://127.0.0.1:13305/v1");
			expect(launch.env.COPILOT_PROVIDER_TYPE).toBe("openai");
			expect(launch.env.COPILOT_PROVIDER_API_KEY).toBe("test-value");
		} finally {
			delete process.env.TEST_COPILOT_KEY;
		}
	});

	it("warns and falls back to the subscription for an unknown provider profile", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch(copilotInput({ agentSettings: { providerId: "nope" } }));
		expect(launch.env.COPILOT_PROVIDER_BASE_URL).toBeUndefined();
		expect(launch.sessionWarning).toContain('"nope"');
	});

	it("pre-trusts the worktree under both trusted-folder keys", async () => {
		const home = setupTempHome();
		const input = copilotInput();
		await prepareAgentLaunch(input);
		const config = JSON.parse(readFileSync(join(home, ".copilot", "config.json"), "utf8"));
		expect(config.trustedFolders).toContain(input.cwd);
		expect(config.trusted_folders).toContain(input.cwd);
	});

	it("keeps the login and the comment header of Copilot's JSONC config when pre-trusting", async () => {
		const home = setupTempHome();
		const configPath = join(home, ".copilot", "config.json");
		mkdirSync(join(home, ".copilot"), { recursive: true });
		const header = "// User settings belong in settings.json.\n// This file is managed automatically.\n";
		const login = {
			authTokens: { "https://ghe.example.com:octo": "gho_secret" },
			loggedInUsers: [{ host: "https://ghe.example.com", login: "octo" }],
			lastLoggedInUser: { host: "https://ghe.example.com", login: "octo" },
			trustedFolders: ["/already/trusted"],
		};
		writeFileSync(configPath, `${header}${JSON.stringify(login, null, 2)}\n`, "utf8");
		const input = copilotInput();
		await prepareAgentLaunch(input);
		const written = readFileSync(configPath, "utf8");
		expect(written.startsWith(header)).toBe(true);
		const config = parseCopilotConfig(written)?.config;
		expect(config?.authTokens).toEqual(login.authTokens);
		expect(config?.loggedInUsers).toEqual(login.loggedInUsers);
		expect(config?.lastLoggedInUser).toEqual(login.lastLoggedInUser);
		expect(config?.trustedFolders).toEqual(["/already/trusted", input.cwd]);
		expect(config?.trusted_folders).toEqual([input.cwd]);
	});

	it("writes the config through a temp file + rename and leaves no temp file behind", async () => {
		const home = setupTempHome();
		const copilotHome = join(home, ".copilot");
		mkdirSync(copilotHome, { recursive: true });
		writeFileSync(join(copilotHome, "config.json"), '// header\n{ "theme": "dark" }\n', "utf8");
		const launch = await prepareAgentLaunch(copilotInput());
		expect(readdirSync(copilotHome)).toEqual(["config.json"]);
		expect(launch.sessionWarning).toBeUndefined();
		const written = readFileSync(join(copilotHome, "config.json"), "utf8");
		expect(written.startsWith("// header\n")).toBe(true);
		expect(parseCopilotConfig(written)?.config.theme).toBe("dark");
	});

	it("leaves a config it can't parse untouched", async () => {
		const home = setupTempHome();
		const configPath = join(home, ".copilot", "config.json");
		mkdirSync(join(home, ".copilot"), { recursive: true });
		const garbled = '// managed\n{ "authTokens": { "x": "gho_secret" }, oops }\n';
		writeFileSync(configPath, garbled, "utf8");
		const launch = await prepareAgentLaunch(copilotInput());
		expect(readFileSync(configPath, "utf8")).toBe(garbled);
		expect(launch.sessionWarning).toContain("left untouched");
	});
});

describe("parseCopilotConfig", () => {
	it("parses JSONC with a // header and keeps // inside strings", () => {
		const parsed = parseCopilotConfig('// a\n// b\n{\n  "url": "https://x//y" // trailing\n}\n');
		expect(parsed?.header).toBe("// a\n// b\n");
		expect(parsed?.config).toEqual({ url: "https://x//y" });
	});

	it("treats an empty file as an empty config and rejects non-objects", () => {
		expect(parseCopilotConfig("")).toEqual({ header: "", config: {} });
		expect(parseCopilotConfig("// only\n[1]\n")).toBeNull();
		expect(parseCopilotConfig("{ broken")).toBeNull();
	});
});
