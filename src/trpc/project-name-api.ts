// The runtime side of `kanban project rename` and the browser's project menu Rename (issue #43): a project's display
// name (`workspaces.<id>.name`, src/projects/project-display-name.ts). The server decides who calls with the strict
// caller lookup, in every isolation mode, off included, as for the QA pipeline pause (pipeline-pause-api.ts):
//   - the user: allowed;
//   - the orchestrator of THAT workspace (its sidebar session or its headless wake): allowed;
//   - another workspace's orchestrator, any card session, an unidentified caller: refused (isolation log).
// A change sends every client the project list again, which shows the name.
import { z } from "zod";

import type { IsolationService } from "../isolation/isolation-service";
import { describeCaller, type RuntimeCaller } from "../isolation/session-identity";
import { PROJECT_DISPLAY_NAME_MAX_LENGTH, setProjectDisplayName } from "../projects/project-display-name";

export const projectNameRequestSchema = z.object({
	/** The new display name, or null to drop it (the directory name is shown). */
	name: z
		.string()
		.max(PROJECT_DISPLAY_NAME_MAX_LENGTH * 4)
		.nullable(),
});

export const projectNameResponseSchema = z.object({
	ok: z.boolean(),
	name: z.string().nullable(),
	previous: z.string().nullable(),
	changed: z.boolean(),
	error: z.string().optional(),
});
export type ProjectNameResponse = z.infer<typeof projectNameResponseSchema>;

export type ProjectNameCallerDecision = { allowed: true; by: string } | { allowed: false; message: string };

/** Who may rename `workspaceId`: the user and that project's own orchestrator. */
export function decideProjectNameCaller(caller: RuntimeCaller, workspaceId: string): ProjectNameCallerDecision {
	if (caller.kind === "user") {
		return { allowed: true, by: "user" };
	}
	if (caller.kind === "session" && caller.session.role === "orchestrator") {
		if (caller.session.workspaceId === workspaceId) {
			return { allowed: true, by: `orchestrator ${caller.session.taskId}` };
		}
		return {
			allowed: false,
			message: `The name of ${workspaceId} is changed only by the user and ${workspaceId}'s own orchestrator, not ${describeCaller(caller)}. Send ${workspaceId}'s orchestrator a message (kanban message send).`,
		};
	}
	return {
		allowed: false,
		message: `A project's name is changed only by the user and the project's orchestrator; ${describeCaller(caller)} can't. Tell your orchestrator what you need.`,
	};
}

export interface RuntimeProjectNameApi {
	setName: (input: {
		caller: RuntimeCaller;
		workspaceId: string;
		request: z.infer<typeof projectNameRequestSchema>;
	}) => Promise<ProjectNameResponse>;
}

export interface CreateProjectNameApiDependencies {
	log: IsolationService["log"];
	/** Sends every client the project list again (its names). */
	broadcastProjects?: (workspaceId: string) => void;
	/** Tests: where config.json and the Kanban home live. */
	configPath?: string;
	homePath?: string;
	now?: () => number;
}

export function createProjectNameApi(deps: CreateProjectNameApiDependencies): RuntimeProjectNameApi {
	return {
		setName: async ({ caller, workspaceId, request }) => {
			const decision = decideProjectNameCaller(caller, workspaceId);
			if (!decision.allowed) {
				await deps.log([workspaceId, caller.kind === "session" ? caller.session.workspaceId : null], {
					kind: "refused",
					taskId: caller.kind === "session" ? caller.session.taskId : null,
					from: caller.kind === "session" ? caller.session.workspaceId : null,
					to: workspaceId,
					action: "project.rename",
					detail: `renaming a project is the user's and the project orchestrator's (${caller.kind === "session" ? `${caller.session.role} via ${caller.via}` : caller.kind === "unknown" ? caller.reason : "user"})`,
				});
				return { ok: false, name: null, previous: null, changed: false, error: decision.message };
			}
			try {
				const change = await setProjectDisplayName({
					workspaceId,
					name: request.name,
					by: decision.by,
					configPath: deps.configPath,
					homePath: deps.homePath,
					now: deps.now,
				});
				if (change.changed) {
					deps.broadcastProjects?.(workspaceId);
				}
				return { ok: true, name: change.name, previous: change.previous, changed: change.changed };
			} catch (error) {
				return {
					ok: false,
					name: null,
					previous: null,
					changed: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
}
