// The isolation decisions, pure: may a caller reach a workspace, and may it change the project list. The runtime
// API (src/trpc/isolation-guard.ts) and the Kanban CLI's in-process scope (src/isolation/cli-scope.ts) both ask here.
import type { IsolationMode, PipelineConfig } from "../config/pipeline-config";
import { describeIsolationAction } from "./action-names";
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
	/** What was attempted (a tRPC path, `cli <command>`), named in the refusal. */
	action?: string;
}

/**
 * Why an unidentified caller's credential didn't count, when the likely cause is a process that left its session's
 * tree (a detached or daemonized command): such a process loses the session's identity.
 */
function unknownCallerHint(caller: RuntimeCaller): string {
	return caller.kind === "unknown" && caller.reason.includes("outside its session's process tree")
		? " A process started outside the session's process tree (detached, daemonized) doesn't carry the session's identity: run the command in the foreground of the session."
		: "";
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
	const what = describeIsolationAction(input.action ?? "this request", toWorkspaceId);
	const message =
		caller.kind === "session"
			? `Project isolation refused "${what}": ${describeCaller(caller)} can only work on its own project. Ask the user, or send that project's orchestrator a message (\`kanban message send\`) if both projects allow it.`
			: `Project isolation refused "${what}": the caller is ${describeCaller(caller)}, and project ${toWorkspaceId} is in isolation ${mode}, which takes only its own identified sessions and the user.${unknownCallerHint(caller)}`;
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
	/** The path or project the request names, for the refusal. */
	target?: string | null;
}): { allowed: true } | { allowed: false; message: string } {
	const { caller } = input;
	if (caller.kind === "user") {
		return { allowed: true };
	}
	if (caller.kind === "session" && input.kind === "add" && input.targetWorkspaceId === caller.session.workspaceId) {
		return { allowed: true };
	}
	if (input.kind === "add" && input.targetWorkspaceId) {
		// Another project's registration: nothing would change, but it names a project the session doesn't own.
		return {
			allowed: false,
			message: `Project isolation refused "${describeIsolationAction("projects.add", input.targetWorkspaceId)}": ${describeCaller(caller)} can only work on its own project, whatever the isolation mode. Ask the user, or send that project's orchestrator a message (\`kanban message send\`) if both projects allow it.${unknownCallerHint(caller)}`,
		};
	}
	const target = input.target?.trim() || input.targetWorkspaceId;
	const what =
		input.kind === "create"
			? `create a Kanban project${target ? ` at ${target}` : ""}`
			: input.kind === "add"
				? `register ${target ?? "a new project"} as a Kanban project`
				: `remove project ${target ?? "a Kanban project"}`;
	return {
		allowed: false,
		message: `Only the user can ${what} (Kanban's UI, or \`kanban project ${input.kind}\` in their own shell); ${describeCaller(caller)} can't, and must not ask another project's orchestrator to do it. Tell the user what you need.${unknownCallerHint(caller)}`,
	};
}
