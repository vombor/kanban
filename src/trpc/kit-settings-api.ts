// The runtime side of `kanban kit set|unset|apply` (src/kits/project-settings.ts, src/kits/apply-kit.ts): a project's
// kit and its settings on it (every model the kit names, project facts) change only through here, so the server decides who calls with the strict caller lookup
// (a session without its credential is traced to its process tree), in every isolation mode, off included:
//   - the user: allowed;
//   - the orchestrator of THAT workspace (its sidebar session or its headless wake): allowed;
//   - another workspace's orchestrator, any card session, an unidentified caller: refused.
// The change applies at once: no card, no land, no console code. A kit itself (the team definition) is never changed
// here: kits are created and edited only by the user (`kanban kit create|edit`). A switch's landing mode (`--landing`)
// follows the same rule (user, 2026-10-13, issue #42); removing a stored team key stays the user's (applyWorkspaceKit
// refuses it for the orchestrator).

import { z } from "zod";
import { runtimeLandingModeSchema } from "../core/api-contract";

import type { IsolationService } from "../isolation/isolation-service";
import { describeCaller, type RuntimeCaller } from "../isolation/session-identity";
import { type ApplyKitResult, applyWorkspaceKit } from "../kits/apply-kit";
import { kitRecommendedSettingSchema } from "../kits/kit-schema";
import {
	type KitSettingChangeResult,
	KitSettingRefusedError,
	type KitSettingsActor,
	setProjectKitSetting,
	unsetProjectKitSetting,
} from "../kits/project-settings";
import { getKitSettingsHistoryPath } from "../state/kanban-home";

export const kitSettingSetRequestSchema = z.object({ key: z.string().min(1), value: z.unknown() });
export const kitSettingUnsetRequestSchema = z.object({ key: z.string().min(1) });
export const kitApplyRequestSchema = z.object({
	kitName: z.string().min(1),
	/** The team kit's preset; null = a custom team; missing keeps the workspace's own preset on the same kit. */
	preset: z.string().min(1).nullable().optional(),
	landing: runtimeLandingModeSchema.optional(),
	set: z.record(z.string(), z.unknown()).optional(),
	unset: z.array(z.string().min(1)).optional(),
	dryRun: z.boolean().optional(),
});
export type KitApplyRequest = z.infer<typeof kitApplyRequestSchema>;

const kitApplyResultSchema = z.object({
	workspaceId: z.string(),
	kitName: z.object({ from: z.string(), to: z.string() }),
	preset: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
	landing: z.object({ from: runtimeLandingModeSchema, to: runtimeLandingModeSchema }),
	overrides: z.record(z.string(), z.unknown()),
	changes: z.array(
		z.object({
			key: z.string(),
			from: z.unknown(),
			to: z.unknown(),
			fromSource: z.string().nullable(),
			toSource: z.string().nullable(),
		}),
	),
	dropped: z.array(z.object({ key: z.string(), value: z.unknown(), why: z.string() })),
	recommendedLandingMode: runtimeLandingModeSchema.nullable(),
	unmetSettings: z.array(
		z.object({
			setting: kitRecommendedSettingSchema,
			configKey: z.string(),
			current: z.unknown(),
			status: z.enum(["met", "unmet", "unknown"]),
		}),
	),
	previousIssues: z.array(z.string()),
	written: z.boolean(),
	historyPath: z.string().nullable(),
});

export const kitApplyResponseSchema = z.object({
	ok: z.boolean(),
	result: kitApplyResultSchema.nullable(),
	error: z.string().optional(),
});
export type KitApplyResponse = z.infer<typeof kitApplyResponseSchema>;

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
	/** `kanban kit apply`: switch the project's kit (and edit its settings), the same caller rule. */
	apply: (input: {
		caller: RuntimeCaller;
		workspaceId: string;
		request: KitApplyRequest;
	}) => Promise<KitApplyResponse>;
}

export interface CreateKitSettingsApiDependencies {
	log: IsolationService["log"];
	/** Tests: where config.json, kits and the history live. */
	paths?: { configPath?: string; kitsDir?: string; historyPath?: string };
}

function toApplyResult(
	result: ApplyKitResult,
	workspaceId: string,
	historyPath: string | undefined,
): KitApplyResponse["result"] {
	return { ...result, historyPath: result.written ? (historyPath ?? getKitSettingsHistoryPath(workspaceId)) : null };
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

function toErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createKitSettingsApi(deps: CreateKitSettingsApiDependencies): RuntimeKitSettingsApi {
	/** The caller decision, logged when refused. */
	const decide = async (
		action: "kit.set" | "kit.unset" | "kit.apply",
		caller: RuntimeCaller,
		workspaceId: string,
		key: string,
	): Promise<KitSettingsCallerDecision> => {
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
		}
		return decision;
	};
	const run = async (
		action: "kit.set" | "kit.unset",
		caller: RuntimeCaller,
		workspaceId: string,
		key: string,
		change: (actor: KitSettingsActor) => Promise<KitSettingChangeResult>,
	): Promise<KitSettingChangeResponse> => {
		const decision = await decide(action, caller, workspaceId, key);
		if (!decision.allowed) {
			return failure(decision.message);
		}
		try {
			return toResponse(await change(decision.actor));
		} catch (error) {
			if (error instanceof KitSettingRefusedError) {
				return failure(error.message);
			}
			return failure(toErrorText(error));
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
		apply: async ({ caller, workspaceId, request }) => {
			const decision = await decide(
				"kit.apply",
				caller,
				workspaceId,
				`(kit) ${request.kitName}${request.preset ? ` (preset ${request.preset})` : request.preset === null ? " (custom)" : ""}`,
			);
			if (!decision.allowed) {
				return { ok: false, result: null, error: decision.message };
			}
			try {
				const result = await applyWorkspaceKit({ workspaceId, ...request, by: decision.actor, ...deps.paths });
				return { ok: true, result: toApplyResult(result, workspaceId, deps.paths?.historyPath) };
			} catch (error) {
				return { ok: false, result: null, error: toErrorText(error) };
			}
		},
	};
}
