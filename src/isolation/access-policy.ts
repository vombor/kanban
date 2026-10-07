// The isolation decisions, pure: may a caller reach a workspace, and may it change the project list. The runtime
// API (src/trpc/isolation-guard.ts) and the Kanban CLI's in-process scope (src/isolation/cli-scope.ts) both ask here.
import type { IsolationMode, PipelineConfig } from "../config/pipeline-config";
import type { IsolationGrant } from "./grants";
import { resolveIsolationMode, resolveReachIsolationMode } from "./isolation-settings";
import { describeCaller, type RuntimeCaller } from "./session-identity";

export type WorkspaceAccessDecision =
	| { outcome: "allow"; grant?: IsolationGrant; mode: IsolationMode }
	| { outcome: "report"; mode: "report"; message: string }
	| { outcome: "refuse"; mode: "enforce"; message: string };

export interface WorkspaceAccessInput {
	config: PipelineConfig;
	caller: RuntimeCaller;
	toWorkspaceId: string;
	/** The user's grant for this session and workspace, if one is live. */
	grant: IsolationGrant | null;
}

export function decideWorkspaceAccess(input: WorkspaceAccessInput): WorkspaceAccessDecision {
	const { caller, toWorkspaceId } = input;
	if (caller.kind === "user" || (caller.kind === "session" && caller.session.workspaceId === toWorkspaceId)) {
		return { outcome: "allow", mode: "off" };
	}
	// An unidentified session has no project of its own: the target's mode decides.
	const mode =
		caller.kind === "session"
			? resolveReachIsolationMode(input.config, caller.session.workspaceId, toWorkspaceId)
			: resolveIsolationMode(input.config, toWorkspaceId);
	if (mode === "off") {
		return { outcome: "allow", mode };
	}
	if (input.grant) {
		return { outcome: "allow", grant: input.grant, mode };
	}
	const message = `Project isolation: ${describeCaller(caller)} can only work on its own project; this request names another one. Ask the user, or send that project's orchestrator a message (\`kanban message send\`) if both projects allow it.`;
	return mode === "report" ? { outcome: "report", mode, message } : { outcome: "refuse", mode, message };
}

export type ProjectChangeKind = "create" | "add" | "remove";

/**
 * Creating, registering and removing projects is the user's (Kanban's UI and CLI): every agent session is refused,
 * whatever the isolation mode, except re-registering its own already registered project (a no-op that `kanban task
 * create` and `kanban doctor --fix` may ask for). `targetWorkspaceId` is the registered workspace the request names,
 * or null for a path that isn't registered.
 */
export function decideProjectChange(input: {
	caller: RuntimeCaller;
	kind: ProjectChangeKind;
	targetWorkspaceId: string | null;
}): { allowed: true } | { allowed: false; message: string } {
	const { caller } = input;
	if (caller.kind === "user") {
		return { allowed: true };
	}
	if (caller.kind === "session" && input.kind === "add" && input.targetWorkspaceId === caller.session.workspaceId) {
		return { allowed: true };
	}
	const verb = input.kind === "create" ? "create" : input.kind === "add" ? "register" : "remove";
	return {
		allowed: false,
		message: `Only the user can ${verb} a Kanban project (Kanban's UI, or \`kanban project ${input.kind}\` in their own shell); ${describeCaller(caller)} can't, and must not ask another project's orchestrator to do it. Tell the user what you need.`,
	};
}
