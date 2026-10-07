import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

const agentRegistryMocks = vi.hoisted(() => ({
	resolveAgentCommand: vi.fn(),
	buildRuntimeConfigResponse: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
}));

const browserMocks = vi.hoisted(() => ({
	openInBrowser: vi.fn(),
}));

const guardrailMocks = vi.hoisted(() => ({
	resolveTaskGuardrails: vi.fn(),
}));

const boardMocks = vi.hoisted(() => ({
	loadWorkspaceBoardById: vi.fn(),
}));

vi.mock("../../../src/terminal/agent-registry.js", () => ({
	resolveAgentCommand: agentRegistryMocks.resolveAgentCommand,
	buildRuntimeConfigResponse: agentRegistryMocks.buildRuntimeConfigResponse,
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	resolveTaskCwd: taskWorktreeMocks.resolveTaskCwd,
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
}));

vi.mock("../../../src/guardrails/task-guardrails.js", () => ({
	resolveTaskGuardrails: guardrailMocks.resolveTaskGuardrails,
}));

vi.mock("../../../src/state/workspace-state.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/state/workspace-state")>()),
	loadWorkspaceBoardById: boardMocks.loadWorkspaceBoardById,
}));

vi.mock("../../../src/server/browser.js", () => ({
	openInBrowser: browserMocks.openInBrowser,
}));

import { getKanbanGlobalConfigPath } from "../../../src/state/kanban-home";
import type { RuntimeTrpcContext } from "../../../src/trpc/app-router";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../../src/trpc/runtime-api";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

type OptionalRuntimeApiDependency =
	| "getUpdateStatus"
	| "runUpdateNow"
	| "getProcessSweep"
	| "runProcessSweep"
	| "sessionSyncEnabled";

const PROCESS_SWEEP_RESPONSE = {
	supported: true,
	settings: { enabled: true, intervalSec: 300, mode: "terminate" as const },
	lastSweep: null,
};

function createTestRuntimeApi(
	deps: Omit<CreateRuntimeApiDependencies, OptionalRuntimeApiDependency> &
		Partial<Pick<CreateRuntimeApiDependencies, OptionalRuntimeApiDependency>>,
): RuntimeTrpcContext["runtimeApi"] {
	return createRuntimeApi({
		...deps,
		getUpdateStatus:
			deps.getUpdateStatus ??
			vi.fn(() => ({
				currentVersion: "0.1.0",
				latestVersion: null,
				updateAvailable: false,
				updateTiming: null,
				installCommand: null,
			})),
		runUpdateNow:
			deps.runUpdateNow ??
			vi.fn(async () => ({
				status: "unsupported_installation" as const,
				currentVersion: "0.1.0",
				latestVersion: null,
				message: "On-demand updates are not available in this test runtime.",
			})),
		getProcessSweep: deps.getProcessSweep ?? vi.fn(async () => PROCESS_SWEEP_RESPONSE),
		runProcessSweep: deps.runProcessSweep ?? vi.fn(async () => PROCESS_SWEEP_RESPONSE),
		sessionSyncEnabled: deps.sessionSyncEnabled ?? true,
	});
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createRuntimeConfigState(): RuntimeConfigState {
	return {
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
	};
}

describe("createRuntimeApi startTaskSession", () => {
	beforeEach(() => {
		agentRegistryMocks.resolveAgentCommand.mockReset();
		agentRegistryMocks.buildRuntimeConfigResponse.mockReset();
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
		browserMocks.openInBrowser.mockReset();
		guardrailMocks.resolveTaskGuardrails.mockReset();
		boardMocks.loadWorkspaceBoardById.mockReset();
		boardMocks.loadWorkspaceBoardById.mockRejectedValue(new Error("no board"));
		guardrailMocks.resolveTaskGuardrails.mockResolvedValue(null);
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "claude",
			label: "Claude Code",
			command: "claude",
			binary: "claude",
			args: [],
		});
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockResolvedValue({
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: Date.now(),
		});
	});

	it("reuses an existing worktree path before falling back to ensure", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Investigate startup freeze",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledTimes(1);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: false,
		});
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/existing-worktree",
			}),
		);
	});

	it("ensures the worktree when no existing task cwd is available", async () => {
		taskWorktreeMocks.resolveTaskCwd
			.mockRejectedValueOnce(new Error("missing"))
			.mockResolvedValueOnce("/tmp/new-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Investigate startup freeze",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenNthCalledWith(1, {
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: false,
		});
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenNthCalledWith(2, {
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: true,
		});
	});

	it("starts home agent sessions in the workspace root without resolving a task worktree", async () => {
		const homeTaskId = "__home_agent__:workspace-1:codex";
		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ taskId: homeTaskId })),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: homeTaskId,
				baseRef: "main",
				prompt: "",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: homeTaskId,
				cwd: "/tmp/repo",
				// The orchestrator works across the project's worktrees: no guardrails.
				guardrails: null,
			}),
		);
		expect(guardrailMocks.resolveTaskGuardrails).not.toHaveBeenCalled();
		expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
	});

	it("passes a card session the guardrails resolved for its worktree, project and base branch", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		const guardrails = { worktreePath: "/tmp/existing-worktree", deniedCommands: [] };
		guardrailMocks.resolveTaskGuardrails.mockResolvedValue(guardrails);
		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "fork/stack", prompt: "Fix it" },
		);

		expect(response.ok).toBe(true);
		expect(guardrailMocks.resolveTaskGuardrails).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				workspaceId: "workspace-1",
				worktreePath: "/tmp/existing-worktree",
				projectPath: "/tmp/repo",
				baseRef: "fork/stack",
			}),
		);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(expect.objectContaining({ guardrails }));
	});

	it("passes the card's git action to the guardrails, so a PR card may push its own branch", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		boardMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ id: "review", title: "Review", cards: [{ id: "task-1", autoReviewMode: "pr" }] }],
			dependencies: [],
		});
		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
		});

		await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "fork/stack", prompt: "Fix it" },
		);
		expect(boardMocks.loadWorkspaceBoardById).toHaveBeenCalledWith("workspace-1");
		expect(guardrailMocks.resolveTaskGuardrails).toHaveBeenCalledWith(expect.objectContaining({ gitAction: "pr" }));

		// No readable board: no git action, so push stays denied.
		boardMocks.loadWorkspaceBoardById.mockRejectedValue(new Error("unreadable"));
		await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "fork/stack", prompt: "Fix it" },
		);
		expect(guardrailMocks.resolveTaskGuardrails).toHaveBeenLastCalledWith(
			expect.objectContaining({ gitAction: null }),
		);
	});

	it("launches Cline cards as a terminal agent with the card's provider and model", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "cline",
			label: "Cline",
			command: "cline --auto-approve true",
			binary: "cline",
			args: ["--auto-approve", "true"],
		});
		const terminalManager = {
			getSummary: vi.fn(() => null),
			startTaskSession: vi.fn(async () => createSummary({ agentId: "cline" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Add coupons",
				agentId: "cline",
				agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
			},
		);

		expect(response.ok).toBe(true);
		expect(agentRegistryMocks.resolveAgentCommand).toHaveBeenCalledWith(
			expect.objectContaining({ selectedAgentId: "cline" }),
		);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "cline",
				binary: "cline",
				agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
			}),
		);
	});

	it("accepts the old cline-cli agent id as an alias of cline", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		const terminalManager = {
			getSummary: vi.fn(() => null),
			startTaskSession: vi.fn(async () => createSummary({ agentId: "cline" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", prompt: "Add coupons", agentId: "cline-cli" as never },
		);

		expect(response.ok).toBe(true);
		expect(agentRegistryMocks.resolveAgentCommand).toHaveBeenCalledWith(
			expect.objectContaining({ selectedAgentId: "cline" }),
		);
	});
});

describe("createRuntimeApi resetAllState", () => {
	it("runs reset teardown before deleting debug state paths", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [join(tempHome, ".kanban"), join(tempHome, ".kanban", "worktrees")];
		// Cline's data is Cline's: the reset never deletes it.
		const clineDataPath = join(tempHome, ".cline", "data");
		for (const path of [...debugPaths, clineDataPath]) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const prepareForStateReset = vi.fn(async () => {
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(true);
			}
		});
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			prepareForStateReset,
		});

		try {
			const response = await api.resetAllState(null);

			expect(response.ok).toBe(true);
			expect(prepareForStateReset).toHaveBeenCalledTimes(1);
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(false);
			}
			expect(existsSync(join(clineDataPath, "marker.txt"))).toBe(true);
			expect(response.clearedPaths).not.toContain(clineDataPath);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("aborts reset path deletion when teardown fails", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [
			join(tempHome, ".cline", "data"),
			join(tempHome, ".kanban"),
			join(tempHome, ".kanban", "worktrees"),
		];
		for (const path of debugPaths) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			prepareForStateReset: vi.fn(async () => {
				throw new Error("teardown failed");
			}),
		});

		try {
			await expect(api.resetAllState(null)).rejects.toThrow("teardown failed");
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(true);
			}
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});

describe("createRuntimeApi update handlers", () => {
	it("delegates update status to the required dependency", async () => {
		const getUpdateStatus = vi.fn(() => ({
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			updateAvailable: true,
			updateTiming: "startup" as const,
			installCommand: "npm install -g kanban@latest",
		}));
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			getUpdateStatus,
		});

		await expect(api.getUpdateStatus(null)).resolves.toEqual({
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			updateAvailable: true,
			updateTiming: "startup",
			installCommand: "npm install -g kanban@latest",
		});
		expect(getUpdateStatus).toHaveBeenCalledTimes(1);
	});

	it("delegates update execution to the required dependency", async () => {
		const runUpdateNow = vi.fn(async () => ({
			status: "updated" as const,
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			message: "Updated Kanban to 0.2.0.",
		}));
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runUpdateNow,
		});

		await expect(api.runUpdateNow(null)).resolves.toEqual({
			status: "updated",
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			message: "Updated Kanban to 0.2.0.",
		});
		expect(runUpdateNow).toHaveBeenCalledTimes(1);
	});
});

describe("createRuntimeApi deliverTaskInput", () => {
	const scope = { workspaceId: "workspace-1", workspacePath: "/tmp/repo" };

	function createApi(terminalManager: { getSummary: unknown; writeInput: unknown }) {
		return createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
		});
	}

	it("types into the scoped task session and returns the typed delivery result", async () => {
		const summary = createSummary();
		const writeInput = vi.fn(() => summary);
		const api = createApi({ getSummary: vi.fn(() => summary), writeInput });

		const response = await api.deliverTaskInput(scope, { taskId: " task-1 ", text: "hello", confirm: false });

		expect(response).toMatchObject({ ok: true, status: "sent", enterAttempts: 1 });
		expect(writeInput.mock.calls.map((call: unknown[]) => String(call[1]))).toEqual(["hello", "\r"]);
	});

	it("reports no_session when the task has no session", async () => {
		const api = createApi({ getSummary: vi.fn(() => null), writeInput: vi.fn(() => null) });

		const response = await api.deliverTaskInput(scope, { taskId: "task-1", text: "hello" });

		expect(response).toMatchObject({ ok: false, status: "no_session", summary: null });
	});

	it("reports an error for an empty taskId", async () => {
		const api = createApi({ getSummary: vi.fn(), writeInput: vi.fn() });

		const response = await api.deliverTaskInput(scope, { taskId: "  ", text: "hello" });

		expect(response).toMatchObject({ ok: false, status: "error" });
		expect(response.error).toMatch(/taskId cannot be empty/);
	});
});

describe("createRuntimeApi loadConfig landing mode", () => {
	beforeEach(() => {
		agentRegistryMocks.buildRuntimeConfigResponse.mockReset();
		agentRegistryMocks.buildRuntimeConfigResponse.mockReturnValue({ selectedAgentId: "claude" });
	});

	it("reports the scoped workspace's landing mode, `off` without an entry, and nothing without a workspace", async () => {
		await withTemporaryKanbanHome(async () => {
			const configPath = getKanbanGlobalConfigPath();
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configPath, JSON.stringify({ workspaces: { foo: { landing: { mode: "qa" } } } }));
			const runtimeConfig = createRuntimeConfigState();
			const api = createTestRuntimeApi({
				getActiveWorkspaceId: vi.fn(() => "foo"),
				getActiveRuntimeConfig: vi.fn(() => runtimeConfig),
				loadScopedRuntimeConfig: vi.fn(async () => runtimeConfig),
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager: vi.fn(),
				resolveInteractiveShellCommand: vi.fn(),
			});

			expect(await api.loadConfig({ workspaceId: "foo", workspacePath: "/repo/foo" })).toMatchObject({
				landingMode: "qa",
			});
			expect(await api.loadConfig({ workspaceId: "bar", workspacePath: "/repo/bar" })).toMatchObject({
				landingMode: "off",
			});
			expect(await api.loadConfig(null)).not.toHaveProperty("landingMode");
		});
	});
});
