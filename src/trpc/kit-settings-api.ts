// The runtime side of `kanban kit set|unset` (src/kits/project-settings.ts): a project's settings on its kit (role
// models and project facts) change only through here, so the server decides who calls with the strict caller lookup
// (a session without its credential is traced to its process tree), in every isolation mode, off included:
//   - the user: allowed;
//   - the orchestrator of THAT workspace (its sidebar session or its headless wake): allowed;
//   - another workspace's orchestrator, any card session, an unidentified caller: refused.
// The change applies at once: no card, no land, no console code. The kit itself (the team definition) is never
// changed here; that is the user's `kanban kit apply`.
import { z } from "zod";

import type { IsolationService } from "../isolation/isolation-service";
import { describeCaller, type RuntimeCaller } from "../isolation/session-identity";
import {
	type KitSettingChangeResult,
	KitSettingRefusedError,
	type KitSettingsActor,
	setProjectKitSetting,
	unsetProjectKitSetting,
} from "../kits/project-settings";

export const kitSettingSetRequestSchema = z.object({ key: z.string().min(1), value: z.unknown() });
export const kitSettingUnsetRequestSchema = z.object({ key: z.string().min(1) });

const kitSettingChangeSchema = z.object({
	key: z.string(),
	from: z.unknown().optional(),
	to: z.unknown().optional(),
});

export const kitSettingChangeResponseSchema = z.object({
	ok: z.boolean(),
	kitName: z.string().nullable(),
	changes: z.array(kitSettingChangeSchema),
	historyPath: z.string().nullable(),
	error: z.string().optional(),
});
export type KitSettingChangeResponse = z.infer<typeof kitSettingChangeResponseSchema>;

export type KitSettingsCallerDecision =
	| { allowed: true; actor: KitSettingsActor }
	| { allowed: false; message: string };

/** Who may change `workspaceId`'s project settings: the user and that project's own orchestrator. */
export function decideKitSettingsCaller(caller: RuntimeCaller, workspaceId: string): KitSettingsCallerDecision {
	if (caller.kind === "user") {
		return { allowed: true, actor: { kind: "user" } };
	}
	if (caller.kind === "session" && caller.session.role === "orchestrator") {
		if (caller.session.workspaceId === workspaceId) {
			return { allowed: true, actor: { kind: "orchestrator", taskId: caller.session.taskId } };
		}
		return {
			allowed: false,
			message: `Project settings of ${workspaceId} are changed only by the user and ${workspaceId}'s own orchestrator, not ${describeCaller(caller)}. Send ${workspaceId}'s orchestrator a message (kanban message send).`,
		};
	}
	return {
		allowed: false,
		message: `Project settings are changed only by the user and the project's orchestrator; ${describeCaller(caller)} can't. Tell your orchestrator what you need.`,
	};
}

export interface RuntimeKitSettingsApi {
	set: (input: {
		caller: RuntimeCaller;
		workspaceId: string;
		request: z.infer<typeof kitSettingSetRequestSchema>;
	}) => Promise<KitSettingChangeResponse>;
	unset: (input: {
		caller: RuntimeCaller;
		workspaceId: string;
		request: z.infer<typeof kitSettingUnsetRequestSchema>;
	}) => Promise<KitSettingChangeResponse>;
}

export interface CreateKitSettingsApiDependencies {
	log: IsolationService["log"];
	/** Tests: where config.json, kits and the history live. */
	paths?: { configPath?: string; kitsDir?: string; historyPath?: string };
}

function toResponse(result: KitSettingChangeResult): KitSettingChangeResponse {
	return {
		ok: true,
		kitName: result.kitName,
		changes: result.changes.map(({ key, from, to }) => ({ key, from, to })),
		historyPath: result.historyPath,
	};
}

function failure(error: string): KitSettingChangeResponse {
	return { ok: false, kitName: null, changes: [], historyPath: null, error };
}

export function createKitSettingsApi(deps: CreateKitSettingsApiDependencies): RuntimeKitSettingsApi {
	const run = async (
		action: "kit.set" | "kit.unset",
		caller: RuntimeCaller,
		workspaceId: string,
		key: string,
		change: (actor: KitSettingsActor) => Promise<KitSettingChangeResult>,
	): Promise<KitSettingChangeResponse> => {
		const decision = decideKitSettingsCaller(caller, workspaceId);
		if (!decision.allowed) {
			await deps.log([workspaceId, caller.kind === "session" ? caller.session.workspaceId : null], {
				kind: "refused",
				taskId: caller.kind === "session" ? caller.session.taskId : null,
				from: caller.kind === "session" ? caller.session.workspaceId : null,
				to: workspaceId,
				action,
				detail: `${key}: project settings are the user's and the project orchestrator's (${caller.kind === "session" ? `${caller.session.role} via ${caller.via}` : caller.kind === "unknown" ? caller.reason : "user"})`,
			});
			return failure(decision.message);
		}
		try {
			return toResponse(await change(decision.actor));
		} catch (error) {
			if (error instanceof KitSettingRefusedError) {
				return failure(error.message);
			}
			return failure(error instanceof Error ? error.message : String(error));
		}
	};
	return {
		set: async ({ caller, workspaceId, request }) =>
			await run(
				"kit.set",
				caller,
				workspaceId,
				request.key,
				async (by) =>
					await setProjectKitSetting({ workspaceId, key: request.key, value: request.value, by, ...deps.paths }),
			),
		unset: async ({ caller, workspaceId, request }) =>
			await run(
				"kit.unset",
				caller,
				workspaceId,
				request.key,
				async (by) => await unsetProjectKitSetting({ workspaceId, key: request.key, by, ...deps.paths }),
			),
	};
}
