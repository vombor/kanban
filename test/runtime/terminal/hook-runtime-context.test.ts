import { describe, expect, it } from "vitest";

import {
	createHookRuntimeArgs,
	createHookRuntimeEnv,
	KANBAN_HOOK_TASK_ID_ENV,
	KANBAN_HOOK_WORKSPACE_ID_ENV,
	parseHookRuntimeContextFromEnv,
	resolveHookRuntimeContext,
} from "../../../src/terminal/hook-runtime-context";

describe("hook-runtime-context", () => {
	it("creates expected environment variables", () => {
		const env = createHookRuntimeEnv({
			taskId: "task-1",
			workspaceId: "workspace-1",
		});
		expect(env).toEqual({
			[KANBAN_HOOK_TASK_ID_ENV]: "task-1",
			[KANBAN_HOOK_WORKSPACE_ID_ENV]: "workspace-1",
		});
	});

	it("parses hook runtime context from env", () => {
		const parsed = parseHookRuntimeContextFromEnv({
			[KANBAN_HOOK_TASK_ID_ENV]: "task-2",
			[KANBAN_HOOK_WORKSPACE_ID_ENV]: "workspace-2",
		});
		expect(parsed).toEqual({
			taskId: "task-2",
			workspaceId: "workspace-2",
		});
	});

	it("throws when required env vars are missing", () => {
		expect(() => parseHookRuntimeContextFromEnv({})).toThrow(
			`Missing required environment variable: ${KANBAN_HOOK_TASK_ID_ENV}`,
		);
	});

	it("prefers ids passed as flags over the env", () => {
		// Cline's hub daemon runs every card's hooks with the env of the card that started it.
		const daemonEnv = { [KANBAN_HOOK_TASK_ID_ENV]: "dev-card", [KANBAN_HOOK_WORKSPACE_ID_ENV]: "foo" };
		expect(resolveHookRuntimeContext({ taskId: "qa-card", workspaceId: "foo" }, daemonEnv)).toEqual({
			taskId: "qa-card",
			workspaceId: "foo",
		});
		expect(resolveHookRuntimeContext({}, daemonEnv)).toEqual({ taskId: "dev-card", workspaceId: "foo" });
	});

	it("never mixes a half-given flag pair with the env", () => {
		const env = { [KANBAN_HOOK_TASK_ID_ENV]: "dev-card", [KANBAN_HOOK_WORKSPACE_ID_ENV]: "foo" };
		expect(() => resolveHookRuntimeContext({ taskId: "qa-card" }, env)).toThrow(
			"--task-id and --workspace-id must be given together",
		);
		expect(() => resolveHookRuntimeContext({ workspaceId: "other" }, env)).toThrow();
	});

	it("builds the flags resolveHookRuntimeContext reads", () => {
		expect(createHookRuntimeArgs({ taskId: "task-3", workspaceId: "workspace-3" })).toEqual([
			"--task-id",
			"task-3",
			"--workspace-id",
			"workspace-3",
		]);
	});
});
