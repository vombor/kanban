// The runtime side of project isolation (docs/fork/project-isolation.md): the checks the tRPC router runs on every
// workspace-scoped call and project change, and the `isolation.*` and `message.*` procedures (whoami, the user's
// grants and their console-code approvals, orchestrator messages). The decisions are src/isolation/access-policy.ts;
// the state is the server's IsolationService.
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import type { IsolationMode } from "../config/pipeline-config";
import type { ProjectChangeKind, WorkspaceAccessDecision } from "../isolation/access-policy";
import type { ApprovalKind } from "../isolation/approvals";
import { type IsolationGrant, MAX_GRANT_MINUTES, ORCHESTRATOR_GRANT_SESSION } from "../isolation/grants";
import type { IsolationService } from "../isolation/isolation-service";
import { isAnyWorkspaceEnforced, resolveIsolationMode } from "../isolation/isolation-settings";
import type { MessageNoticeQueue } from "../isolation/message-notices";
import {
	type OrchestratorMessage,
	readMessageLog,
	resolveProjectAddress,
	sendOrchestratorMessage,
} from "../isolation/messages";
import { describeCaller, type RuntimeCaller } from "../isolation/session-identity";
import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";

export const isolationWhoamiResponseSchema = z.object({
	caller: z.enum(["user", "session", "unknown"]),
	workspaceId: z.string().nullable(),
	taskId: z.string().nullable(),
	role: z.enum(["orchestrator", "card"]).nullable(),
	via: z.enum(["credential", "cwd", "process"]).nullable(),
	mode: z.enum(["off", "report", "enforce"]),
	/** Workspaces the session may reach besides its own; null = every workspace (the user, or isolation off). */
	reachable: z.array(z.string()).nullable(),
});
export type IsolationWhoamiResponse = z.infer<typeof isolationWhoamiResponseSchema>;

const grantSchema = z.object({
	id: z.string(),
	workspaceId: z.string(),
	session: z.string(),
	reach: z.array(z.string()),
	reason: z.string(),
	createdAt: z.string(),
	expiresAt: z.string(),
});

export const isolationGrantRequestSchema = z.object({
	/** The session's workspace: id or project name. */
	project: z.string().min(1),
	/** A task id, or `orchestrator`. */
	session: z.string().min(1),
	/** Projects (id or name) the session may reach. */
	reach: z.array(z.string().min(1)).min(1),
	minutes: z.number().int().positive().max(MAX_GRANT_MINUTES).default(60),
	reason: z.string().min(1).max(500),
});
export const isolationGrantResponseSchema = z.object({
	ok: z.boolean(),
	grant: grantSchema.nullable(),
	/** The pending approval to complete with the code from the server's console (`kanban isolation approve`). */
	approvalId: z.string().nullable(),
	error: z.string().optional(),
});
export const isolationRevokeRequestSchema = z.object({ id: z.string().min(1) });
export const isolationGrantsResponseSchema = z.object({ grants: z.array(grantSchema) });
export const isolationApproveRequestSchema = z.object({ id: z.string().min(1), code: z.string().min(1).max(64) });
export const isolationApproveResponseSchema = z.object({
	ok: z.boolean(),
	result: z.string().nullable(),
	error: z.string().optional(),
});
const approvalKindSchema = z.enum(["grant", "project.create", "project.add", "project.remove", "plan.approve"]);
export const isolationApprovalStatusResponseSchema = z.object({
	approval: z
		.object({
			id: z.string(),
			kind: approvalKindSchema,
			summary: z.string(),
			status: z.enum(["pending", "approved", "refused", "expired"]),
			expiresAt: z.string(),
			result: z.string().nullable(),
		})
		.nullable(),
});
/** The in-process `kanban project add|create` under enforce asks for an approval before it writes. */
export const isolationApprovalRequestSchema = z.object({
	kind: z.enum(["project.create", "project.add", "project.remove"]),
	summary: z.string().min(1).max(500),
});
export const isolationApprovalRequestResponseSchema = z.object({
	ok: z.boolean(),
	approvalId: z.string().nullable(),
	/** No approval needed (no workspace is in enforce). */
	required: z.boolean(),
	error: z.string().optional(),
});

const messageSchema = z.object({
	id: z.string(),
	at: z.string(),
	fromWorkspaceId: z.string(),
	toWorkspaceId: z.string(),
	kind: z.enum(["request", "answer", "refusal"]),
	inReplyTo: z.string().nullable(),
	text: z.string(),
});
export const messageSendRequestSchema = z.object({
	to: z.string().nullable().default(null),
	text: z.string(),
	inReplyTo: z.string().nullable().default(null),
	refuse: z.boolean().default(false),
});
export const messageSendResponseSchema = z.object({
	ok: z.boolean(),
	message: messageSchema.nullable(),
	/** The notice waits for the receiver's settled Review (message-notices.ts). */
	queued: z.boolean(),
	error: z.string().optional(),
});
export const messageInboxRequestSchema = z.object({
	/** For the user: whose messages (id or name). A session always gets its own project's. */
	project: z.string().nullable().default(null),
	limit: z.number().int().positive().max(500).default(50),
});
export const messageInboxResponseSchema = z.object({
	ok: z.boolean(),
	workspaceId: z.string().nullable(),
	messages: z.array(messageSchema),
	error: z.string().optional(),
});

type ChangeDecision = { allowed: true } | { allowed: false; message: string };

export interface RuntimeIsolationApi {
	checkWorkspaceAccess: (
		caller: RuntimeCaller,
		workspaceId: string,
		action: string,
	) => Promise<WorkspaceAccessDecision>;
	/**
	 * A project create/add/remove: refused for sessions in every mode; for anyone else while some workspace is in
	 * enforce, held as an approval (the console code) that runs `run` once approved, unless `trustedBrowser`.
	 */
	checkProjectChange: (input: {
		caller: RuntimeCaller;
		kind: ProjectChangeKind;
		target: { path?: string | null; workspaceId?: string | null };
		action: string;
		/** A passcode-authenticated browser (remote mode): the user, no approval needed. */
		trustedBrowser: boolean;
		run: () => Promise<string>;
	}) => Promise<ChangeDecision>;
	/** The projects a session may see: its own and the ones isolation lets it reach. */
	filterVisibleWorkspaceIds: (caller: RuntimeCaller, workspaceIds: readonly string[]) => Promise<Set<string>>;
	/** Machine-wide operations (config reset, update, settings without a workspace): refused for sessions under enforce. */
	checkMachineAction: (caller: RuntimeCaller, action: string) => Promise<ChangeDecision>;
	whoami: (caller: RuntimeCaller) => Promise<IsolationWhoamiResponse>;
	grant: (
		caller: RuntimeCaller,
		input: z.infer<typeof isolationGrantRequestSchema>,
	) => Promise<z.infer<typeof isolationGrantResponseSchema>>;
	approve: (
		caller: RuntimeCaller,
		input: z.infer<typeof isolationApproveRequestSchema>,
	) => Promise<z.infer<typeof isolationApproveResponseSchema>>;
	approvalStatus: (id: string) => z.infer<typeof isolationApprovalStatusResponseSchema>;
	requestApproval: (
		caller: RuntimeCaller,
		input: z.infer<typeof isolationApprovalRequestSchema>,
	) => Promise<z.infer<typeof isolationApprovalRequestResponseSchema>>;
	revoke: (caller: RuntimeCaller, id: string) => Promise<z.infer<typeof isolationGrantResponseSchema>>;
	listGrants: (caller: RuntimeCaller) => Promise<{ grants: IsolationGrant[] }>;
	sendMessage: (
		caller: RuntimeCaller,
		input: z.infer<typeof messageSendRequestSchema>,
	) => Promise<z.infer<typeof messageSendResponseSchema>>;
	inbox: (
		caller: RuntimeCaller,
		input: z.infer<typeof messageInboxRequestSchema>,
	) => Promise<z.infer<typeof messageInboxResponseSchema>>;
}

export interface CreateIsolationApiDependencies {
	service: IsolationService;
	listEntries: () => Promise<RuntimeWorkspaceIndexEntry[]>;
	notices: Pick<MessageNoticeQueue, "allowSend" | "enqueue">;
}

async function realpathOrSelf(path: string): Promise<string> {
	return await realpath(path).catch(() => path);
}

function userOnly(caller: RuntimeCaller, what: string): string | null {
	return caller.kind === "user"
		? null
		: `Only the user can ${what} (in their own terminal, with the code from the Kanban server's console); ${describeCaller(caller)} can't.`;
}

function approvalNeededMessage(approvalId: string, what: string): string {
	return `${what} needs your approval: the Kanban server printed a code for approval ${approvalId} on its console (the terminal that started Kanban, or \`podman logs\` for the container). Run \`kanban isolation approve ${approvalId} <code>\` in your own terminal.`;
}

export function createIsolationApi(deps: CreateIsolationApiDependencies): RuntimeIsolationApi {
	const { service } = deps;

	const resolveWorkspace = async (value: string): Promise<string | null> => {
		const resolved = resolveProjectAddress(value, await deps.listEntries(), await service.readConfig());
		return "error" in resolved ? null : resolved.workspaceId;
	};

	const reachableFor = async (caller: RuntimeCaller): Promise<{ mode: IsolationMode; reachable: string[] | null }> => {
		if (caller.kind !== "session") {
			return { mode: "off", reachable: null };
		}
		const config = await service.readConfig();
		const mode = resolveIsolationMode(config, caller.session.workspaceId);
		const reachable: string[] = [];
		let everything = true;
		for (const entry of await deps.listEntries()) {
			if (entry.workspaceId === caller.session.workspaceId) {
				continue;
			}
			const decision = service.peekWorkspaceAccess(caller, entry.workspaceId, config);
			if (decision.outcome === "refuse") {
				everything = false;
			} else {
				reachable.push(entry.workspaceId);
			}
		}
		return { mode, reachable: everything && mode === "off" ? null : reachable };
	};

	const holdForApproval = (kind: ApprovalKind, summary: string, run: () => Promise<string>): string => {
		const approval = service.approvals.request({
			kind,
			summary,
			run: async () => {
				const result = await run();
				await service.log([], {
					kind: "approval",
					taskId: null,
					from: null,
					to: null,
					action: kind,
					detail: summary,
				});
				return result;
			},
		});
		return approval.id;
	};

	return {
		checkWorkspaceAccess: async (caller, workspaceId, action) =>
			await service.checkWorkspaceAccess(caller, workspaceId, action),
		checkProjectChange: async ({ caller, kind, target, action, trustedBrowser, run }) => {
			let targetWorkspaceId = target.workspaceId ?? null;
			if (!targetWorkspaceId && target.path && caller.kind !== "unknown") {
				const base = caller.kind === "session" ? caller.session.cwd || "/" : process.cwd();
				const path = await realpathOrSelf(isAbsolute(target.path) ? target.path : resolve(base, target.path));
				for (const entry of await deps.listEntries()) {
					if ((await realpathOrSelf(entry.repoPath)) === path) {
						targetWorkspaceId = entry.workspaceId;
						break;
					}
				}
			}
			if (caller.kind === "user") {
				// Re-adding a registered project changes nothing (`kanban task create` asks for it on every call).
				if (trustedBrowser || (kind === "add" && targetWorkspaceId)) {
					return { allowed: true };
				}
				if (!isAnyWorkspaceEnforced(await service.readConfig())) {
					return { allowed: true };
				}
				const summary = `${kind} ${target.path ?? target.workspaceId ?? ""}`.trim();
				const approvalId = holdForApproval(`project.${kind}`, summary, run);
				return { allowed: false, message: approvalNeededMessage(approvalId, `Project ${kind} (${summary})`) };
			}
			return await service.checkProjectChange(caller, kind, targetWorkspaceId, action);
		},
		filterVisibleWorkspaceIds: async (caller, workspaceIds) => {
			if (caller.kind === "user") {
				return new Set(workspaceIds);
			}
			const config = await service.readConfig();
			return new Set(
				workspaceIds.filter(
					(workspaceId) => service.peekWorkspaceAccess(caller, workspaceId, config).outcome !== "refuse",
				),
			);
		},
		checkMachineAction: async (caller, action) => {
			if (caller.kind === "user") {
				return { allowed: true };
			}
			const config = await service.readConfig();
			const mode =
				caller.kind === "session"
					? resolveIsolationMode(config, caller.session.workspaceId)
					: isAnyWorkspaceEnforced(config)
						? "enforce"
						: config.isolation.mode;
			if (mode === "off") {
				return { allowed: true };
			}
			await service.log([caller.kind === "session" ? caller.session.workspaceId : null], {
				kind: mode === "enforce" ? "refused" : "reported",
				taskId: caller.kind === "session" ? caller.session.taskId : null,
				from: caller.kind === "session" ? caller.session.workspaceId : null,
				to: null,
				action,
				detail: `machine-wide action (${caller.kind === "session" ? `via ${caller.via}` : caller.reason})`,
			});
			return mode === "enforce"
				? {
						allowed: false,
						message: `Project isolation: ${action} changes machine-wide state, which only the user changes; ${describeCaller(caller)} can't.`,
					}
				: { allowed: true };
		},
		whoami: async (caller) => {
			const { mode, reachable } = await reachableFor(caller);
			if (caller.kind === "session") {
				return {
					caller: "session",
					workspaceId: caller.session.workspaceId,
					taskId: caller.session.taskId,
					role: caller.session.role,
					via: caller.via,
					mode,
					reachable,
				};
			}
			return { caller: caller.kind, workspaceId: null, taskId: null, role: null, via: null, mode, reachable };
		},
		grant: async (caller, input) => {
			const refused = userOnly(caller, "grant a session cross-project access");
			if (refused) {
				return { ok: false, grant: null, approvalId: null, error: refused };
			}
			const workspaceId = await resolveWorkspace(input.project);
			if (!workspaceId) {
				return { ok: false, grant: null, approvalId: null, error: `No project "${input.project}".` };
			}
			const reach: string[] = [];
			for (const value of input.reach) {
				const target = await resolveWorkspace(value);
				if (!target) {
					return { ok: false, grant: null, approvalId: null, error: `No project "${value}".` };
				}
				if (target !== workspaceId) {
					reach.push(target);
				}
			}
			if (reach.length === 0) {
				return { ok: false, grant: null, approvalId: null, error: "A grant names at least one other project." };
			}
			const session = input.session.trim() || ORCHESTRATOR_GRANT_SESSION;
			const reason = input.reason.trim();
			// "No credential and no session above it" is not proof of the user (a reparented process): the grant waits
			// for the code the server prints on its console.
			const approval = service.approvals.request({
				kind: "grant",
				summary: `${session} of ${workspaceId} may reach ${reach.join(", ")} for ${input.minutes} min: ${reason}`,
				run: async () => {
					const grant = service.grants.add({ workspaceId, session, reach, reason, minutes: input.minutes });
					await service.log([workspaceId, ...reach], {
						kind: "grant",
						taskId: grant.session,
						from: workspaceId,
						to: reach.join(","),
						action: "isolation.grant",
						detail: `grant ${grant.id} approved with the console code, until ${grant.expiresAt}: ${grant.reason}`,
					});
					return grant.id;
				},
			});
			return {
				ok: false,
				grant: null,
				approvalId: approval.id,
				error: approvalNeededMessage(approval.id, "The grant"),
			};
		},
		approve: async (caller, input) => {
			const refused = userOnly(caller, "approve an isolation change");
			if (refused) {
				return { ok: false, result: null, error: refused };
			}
			const result = await service.approvals.approve(input.id, input.code);
			return result.ok ? { ok: true, result: result.result } : { ok: false, result: null, error: result.error };
		},
		approvalStatus: (id) => ({ approval: service.approvals.status(id) }),
		requestApproval: async (caller, input) => {
			const refused = userOnly(caller, "change the project list");
			if (refused) {
				return { ok: false, approvalId: null, required: true, error: refused };
			}
			if (!isAnyWorkspaceEnforced(await service.readConfig())) {
				return { ok: true, approvalId: null, required: false };
			}
			const approvalId = holdForApproval(input.kind, `kanban ${input.summary}`, async () => "approved");
			return { ok: true, approvalId, required: true };
		},
		revoke: async (caller, id) => {
			const refused = userOnly(caller, "revoke an isolation grant");
			if (refused) {
				return { ok: false, grant: null, approvalId: null, error: refused };
			}
			const grant = service.grants.revoke(id);
			if (!grant) {
				return { ok: false, grant: null, approvalId: null, error: `No live grant ${id}.` };
			}
			await service.log([grant.workspaceId, ...grant.reach], {
				kind: "grant_revoked",
				taskId: grant.session,
				from: grant.workspaceId,
				to: grant.reach.join(","),
				action: "isolation.revoke",
				detail: `grant ${grant.id} revoked by the user`,
			});
			return { ok: true, grant, approvalId: null };
		},
		listGrants: async (caller) => {
			const grants = service.grants.list();
			if (caller.kind === "user") {
				return { grants };
			}
			return {
				grants:
					caller.kind === "session"
						? grants.filter((grant) => grant.workspaceId === caller.session.workspaceId)
						: [],
			};
		},
		sendMessage: async (caller, input) => {
			const config = await service.readConfig();
			const result = await sendOrchestratorMessage({
				config,
				caller,
				entries: await deps.listEntries(),
				to: input.to,
				text: input.text,
				inReplyTo: input.inReplyTo,
				refuse: input.refuse,
				allowSend: deps.notices.allowSend,
				queueNotice: deps.notices.enqueue,
			});
			if (!result.ok) {
				if (caller.kind === "session") {
					await service.log([caller.session.workspaceId], {
						kind: "message_refused",
						taskId: caller.session.taskId,
						from: caller.session.workspaceId,
						to: input.to,
						action: "message.send",
						detail: result.error,
					});
				}
				return { ok: false, message: null, queued: false, error: result.error };
			}
			return { ok: true, message: result.message, queued: true };
		},
		inbox: async (caller, input) => {
			let workspaceId: string | null;
			if (caller.kind === "unknown") {
				return { ok: false, workspaceId: null, messages: [], error: describeCaller(caller) };
			}
			if (caller.kind === "session") {
				if (caller.session.role !== "orchestrator") {
					return {
						ok: false,
						workspaceId: null,
						messages: [],
						error: "Orchestrator messages are for the project's orchestrator, not its cards.",
					};
				}
				workspaceId = caller.session.workspaceId;
			} else {
				workspaceId = input.project ? await resolveWorkspace(input.project) : null;
				if (!workspaceId) {
					return { ok: false, workspaceId: null, messages: [], error: "Name the project (--project <project>)." };
				}
			}
			const messages: OrchestratorMessage[] = (await readMessageLog(workspaceId)).slice(-input.limit);
			return { ok: true, workspaceId, messages };
		},
	};
}
