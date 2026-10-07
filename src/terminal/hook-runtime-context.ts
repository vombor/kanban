export const KANBAN_HOOK_TASK_ID_ENV = "KANBAN_HOOK_TASK_ID";
export const KANBAN_HOOK_WORKSPACE_ID_ENV = "KANBAN_HOOK_WORKSPACE_ID";

export interface HookRuntimeContext {
	taskId: string;
	workspaceId: string;
}

function requireTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
	return value;
}

export function createHookRuntimeEnv(context: HookRuntimeContext): Record<string, string> {
	return {
		[KANBAN_HOOK_TASK_ID_ENV]: context.taskId,
		[KANBAN_HOOK_WORKSPACE_ID_ENV]: context.workspaceId,
	};
}

/**
 * The card's ids as `kanban hooks ingest|notify` flags, for hook commands that may run in a process the card
 * didn't start: Cline 3.x runs `.cline/hooks` scripts in its shared hub daemon, whose env is the first Cline
 * card's, so the env would report every Cline card's hooks for that one card.
 */
export function createHookRuntimeArgs(context: HookRuntimeContext): string[] {
	return ["--task-id", context.taskId, "--workspace-id", context.workspaceId];
}

export function parseHookRuntimeContextFromEnv(env: NodeJS.ProcessEnv = process.env): HookRuntimeContext {
	const taskId = requireTrimmedEnv(env, KANBAN_HOOK_TASK_ID_ENV);
	const workspaceId = requireTrimmedEnv(env, KANBAN_HOOK_WORKSPACE_ID_ENV);
	return {
		taskId,
		workspaceId,
	};
}

/** Ids passed as flags (createHookRuntimeArgs) win over the env; a half-given pair is an error, never mixed with the env. */
export function resolveHookRuntimeContext(
	flags: { taskId?: string; workspaceId?: string },
	env: NodeJS.ProcessEnv = process.env,
): HookRuntimeContext {
	const taskId = flags.taskId?.trim();
	const workspaceId = flags.workspaceId?.trim();
	if (!taskId && !workspaceId) {
		return parseHookRuntimeContextFromEnv(env);
	}
	if (!taskId || !workspaceId) {
		throw new Error("--task-id and --workspace-id must be given together");
	}
	return { taskId, workspaceId };
}
