import { z } from "zod";

import {
	type RuntimeConfigSaveRequest,
	type RuntimeDirectoryListRequest,
	type RuntimeGitCheckoutRequest,
	type RuntimeHookIngestRequest,
	type RuntimeProjectAddRequest,
	type RuntimeProjectCreateRequest,
	type RuntimeProjectNameCheckRequest,
	type RuntimeProjectRemoveRequest,
	type RuntimeShellSessionStartRequest,
	type RuntimeTaskInputDeliveryRequest,
	type RuntimeTaskSessionInputRequest,
	type RuntimeTaskSessionStartRequest,
	type RuntimeTaskSessionStopRequest,
	type RuntimeTaskTrashRequest,
	type RuntimeTaskWorkspaceInfoRequest,
	type RuntimeTerminalWsClientMessage,
	type RuntimeWorkspaceChangesRequest,
	type RuntimeWorkspaceFileSearchRequest,
	type RuntimeWorkspaceStateSaveRequest,
	type RuntimeWorktreeDeleteRequest,
	type RuntimeWorktreeEnsureRequest,
	runtimeConfigSaveRequestSchema,
	runtimeDirectoryListRequestSchema,
	runtimeGitCheckoutRequestSchema,
	runtimeHookIngestRequestSchema,
	runtimeProjectAddRequestSchema,
	runtimeProjectCreateRequestSchema,
	runtimeProjectNameCheckRequestSchema,
	runtimeProjectRemoveRequestSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeTaskInputDeliveryRequestSchema,
	runtimeTaskSessionInputRequestSchema,
	runtimeTaskSessionStartRequestSchema,
	runtimeTaskSessionStopRequestSchema,
	runtimeTaskTrashRequestSchema,
	runtimeTaskWorkspaceInfoRequestSchema,
	runtimeTerminalWsClientMessageSchema,
	runtimeWorkspaceChangesRequestSchema,
	runtimeWorkspaceFileSearchRequestSchema,
	runtimeWorkspaceStateSaveRequestSchema,
	runtimeWorktreeDeleteRequestSchema,
	runtimeWorktreeEnsureRequestSchema,
} from "./api-contract";
import { isDetailTerminalTaskId } from "./detail-terminal-session";
import { isHomeAgentSessionId } from "./home-agent-session";

const trimmedStringSchema = z.string().transform((value) => value.trim());
const positiveIntegerFromQuerySchema = z.coerce.number().int().positive();

const requiredTrimmedStringSchema = (message: string) => trimmedStringSchema.pipe(z.string().min(1, message));

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new Error(parsed.error.issues[0]?.message ?? "Invalid request payload.");
	}
	return parsed.data;
}

export function parseWorkspaceChangesRequest(query: URLSearchParams): RuntimeWorkspaceChangesRequest {
	const taskId = parseWithSchema(
		requiredTrimmedStringSchema("Missing taskId query parameter."),
		query.get("taskId") ?? "",
	);
	const baseRef = parseWithSchema(
		requiredTrimmedStringSchema("Missing baseRef query parameter."),
		query.get("baseRef") ?? "",
	);
	return parseWithSchema(runtimeWorkspaceChangesRequestSchema, { taskId, baseRef });
}

export function parseTaskWorkspaceInfoRequest(query: URLSearchParams): RuntimeTaskWorkspaceInfoRequest {
	const taskId = parseWithSchema(
		requiredTrimmedStringSchema("Missing taskId query parameter."),
		query.get("taskId") ?? "",
	);
	const baseRef = parseWithSchema(
		requiredTrimmedStringSchema("Missing baseRef query parameter."),
		query.get("baseRef") ?? "",
	);
	return parseWithSchema(runtimeTaskWorkspaceInfoRequestSchema, { taskId, baseRef });
}

export function parseOptionalTaskWorkspaceInfoRequest(query: URLSearchParams): RuntimeTaskWorkspaceInfoRequest | null {
	if (!query.has("taskId")) {
		if (query.has("baseRef")) {
			throw new Error("baseRef query parameter requires taskId.");
		}
		return null;
	}
	return parseTaskWorkspaceInfoRequest(query);
}

export function parseWorkspaceFileSearchRequest(query: URLSearchParams): RuntimeWorkspaceFileSearchRequest {
	const normalizedQuery = parseWithSchema(trimmedStringSchema, query.get("q") ?? "");
	if (!normalizedQuery) {
		return { query: "" };
	}

	const rawLimit = query.get("limit");
	if (rawLimit == null || rawLimit.trim() === "") {
		return parseWithSchema(runtimeWorkspaceFileSearchRequestSchema, {
			query: normalizedQuery,
		});
	}
	const parsedLimit = positiveIntegerFromQuerySchema.safeParse(rawLimit);
	if (!parsedLimit.success) {
		throw new Error("Invalid file search limit parameter.");
	}
	return parseWithSchema(runtimeWorkspaceFileSearchRequestSchema, {
		query: normalizedQuery,
		limit: parsedLimit.data,
	});
}

export function parseGitCheckoutRequest(value: unknown): RuntimeGitCheckoutRequest {
	const parsed = parseWithSchema(runtimeGitCheckoutRequestSchema, value);
	const branch = parsed.branch.trim();
	if (!branch) {
		throw new Error("Branch cannot be empty.");
	}
	return {
		branch,
	};
}

export function parseWorktreeEnsureRequest(value: unknown): RuntimeWorktreeEnsureRequest {
	const parsed = parseWithSchema(runtimeWorktreeEnsureRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid worktree ensure payload.");
	}
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Invalid worktree ensure payload.");
	}
	return {
		taskId,
		baseRef,
	};
}

export function parseWorktreeDeleteRequest(value: unknown): RuntimeWorktreeDeleteRequest {
	const parsed = parseWithSchema(runtimeWorktreeDeleteRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid worktree delete payload.");
	}
	// The route stops the task's session and its detail terminal: a synthetic session id is never a card to delete.
	if (isHomeAgentSessionId(taskId) || isDetailTerminalTaskId(taskId)) {
		throw new Error(`Invalid worktree delete payload: "${taskId}" is not a card's task id.`);
	}
	// trigger, fromColumnId, role and title are reported by the client: the task history's diagnostics only, never
	// a decision.
	return {
		taskId,
		...(parsed.trigger ? { trigger: parsed.trigger } : {}),
		...(parsed.fromColumnId ? { fromColumnId: parsed.fromColumnId } : {}),
		...(parsed.role ? { role: parsed.role } : {}),
		...(parsed.title !== undefined ? { title: parsed.title } : {}),
	};
}

export function parseTaskTrashRequest(value: unknown): RuntimeTaskTrashRequest {
	const parsed = parseWithSchema(runtimeTaskTrashRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid task trash payload.");
	}
	return {
		taskId,
		...(parsed.trigger ? { trigger: parsed.trigger } : {}),
		...(parsed.landing ? { landing: parsed.landing } : {}),
	};
}

export function parseWorkspaceStateSaveRequest(value: unknown): RuntimeWorkspaceStateSaveRequest {
	return parseWithSchema(runtimeWorkspaceStateSaveRequestSchema, value);
}

export function parseProjectCreateRequest(value: unknown): RuntimeProjectCreateRequest {
	const parsed = parseWithSchema(runtimeProjectCreateRequestSchema, value);
	const path = parsed.path.trim();
	if (!path) {
		throw new Error("A project path is required.");
	}
	return {
		path,
		name: parsed.name?.trim() || undefined,
		initialBranch: parsed.initialBranch?.trim() || undefined,
		initialCommit: parsed.initialCommit,
	};
}

export function parseProjectNameCheckRequest(value: unknown): RuntimeProjectNameCheckRequest {
	const parsed = parseWithSchema(runtimeProjectNameCheckRequestSchema, value);
	return { root: parsed.root, name: parsed.name };
}

export function parseProjectAddRequest(value: unknown): RuntimeProjectAddRequest {
	const parsed = parseWithSchema(runtimeProjectAddRequestSchema, value);
	const path = parsed.path?.trim() || undefined;
	const gitUrl = parsed.gitUrl?.trim() || undefined;
	if (!path && !gitUrl) {
		throw new Error("Either path or gitUrl is required.");
	}
	return {
		path,
		gitUrl,
		initializeGit: parsed.initializeGit,
	};
}

export function parseProjectRemoveRequest(value: unknown): RuntimeProjectRemoveRequest {
	const parsed = parseWithSchema(runtimeProjectRemoveRequestSchema, value);
	const projectId = parsed.projectId.trim();
	if (!projectId) {
		throw new Error("Project ID cannot be empty.");
	}
	return {
		projectId,
	};
}

export function parseRuntimeConfigSaveRequest(value: unknown): RuntimeConfigSaveRequest {
	return parseWithSchema(runtimeConfigSaveRequestSchema, value);
}

export function parseTaskSessionStartRequest(value: unknown): RuntimeTaskSessionStartRequest {
	const parsed = parseWithSchema(runtimeTaskSessionStartRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task session taskId cannot be empty.");
	}
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Task session baseRef cannot be empty.");
	}
	return {
		...parsed,
		taskId,
		baseRef,
	};
}

export function parseTaskSessionStopRequest(value: unknown): RuntimeTaskSessionStopRequest {
	const parsed = parseWithSchema(runtimeTaskSessionStopRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid task session stop payload.");
	}
	return {
		taskId,
	};
}

export function parseTaskSessionInputRequest(value: unknown): RuntimeTaskSessionInputRequest {
	const parsed = parseWithSchema(runtimeTaskSessionInputRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task session taskId cannot be empty.");
	}
	return {
		...parsed,
		taskId,
	};
}

export function parseTaskInputDeliveryRequest(value: unknown): RuntimeTaskInputDeliveryRequest {
	const parsed = parseWithSchema(runtimeTaskInputDeliveryRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task input delivery taskId cannot be empty.");
	}
	return {
		...parsed,
		taskId,
	};
}

export function parseShellSessionStartRequest(value: unknown): RuntimeShellSessionStartRequest {
	const parsed = parseWithSchema(runtimeShellSessionStartRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Shell session taskId cannot be empty.");
	}
	if (parsed.workspaceTaskId !== undefined && !parsed.workspaceTaskId.trim()) {
		throw new Error("Invalid shell session workspaceTaskId.");
	}
	const workspaceTaskId = parsed.workspaceTaskId?.trim() || undefined;
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Shell session baseRef cannot be empty.");
	}
	return {
		...parsed,
		taskId,
		workspaceTaskId,
		baseRef,
	};
}

export function parseHookIngestRequest(value: unknown): RuntimeHookIngestRequest {
	const parsed = parseWithSchema(runtimeHookIngestRequestSchema, value);
	const taskId = parsed.taskId.trim();
	const workspaceId = parsed.workspaceId.trim();
	if (!taskId) {
		throw new Error("Missing taskId");
	}
	if (!workspaceId) {
		throw new Error("Missing workspaceId");
	}
	const metadata = parsed.metadata
		? {
				activityText: parsed.metadata.activityText?.trim(),
				toolName: parsed.metadata.toolName?.trim(),
				finalMessage: parsed.metadata.finalMessage?.trim(),
				hookEventName: parsed.metadata.hookEventName?.trim(),
				notificationType: parsed.metadata.notificationType?.trim(),
				source: parsed.metadata.source?.trim(),
			}
		: undefined;
	return {
		...parsed,
		taskId,
		workspaceId,
		metadata,
	};
}

export function parseTerminalWsClientMessage(value: unknown): RuntimeTerminalWsClientMessage | null {
	const parsed = runtimeTerminalWsClientMessageSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return parsed.data;
}

export function parseDirectoryListRequest(value: unknown): RuntimeDirectoryListRequest {
	return parseWithSchema(runtimeDirectoryListRequestSchema, value);
}
