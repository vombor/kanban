// The runtime side of `kanban shortcut` (src/projects/project-shortcuts.ts) and of a shortcut run that asks for a
// port (`{port}` / `{url}`, src/config/shortcut-utils.ts). Who may change a project's shortcuts is decided here with
// the strict caller lookup (a session without its credential is traced to its process tree), in every isolation
// mode, off included, by the kit settings' rule: the user and that workspace's own orchestrator; a card, another
// workspace's orchestrator and an unidentified caller are refused. The board's settings dialog keeps saving
// shortcuts its own way (runtime.saveConfig). A change is pushed to the browser (`project_shortcuts_updated`), which
// reloads the project config. A run's port is the user's click on the board: only the user gets one.
import { z } from "zod";
import { loadProjectShortcuts } from "../config/runtime-config";
import { expandShortcutCommand, shortcutNeedsPort } from "../config/shortcut-utils";
import { runtimeProjectShortcutSchema } from "../core/api-contract";
import type { IsolationService } from "../isolation/isolation-service";
import { describeCaller, type RuntimeCaller } from "../isolation/session-identity";
import type { KitSettingsActor } from "../kits/project-settings";
import {
	removeProjectShortcut,
	type ShortcutChangeResult,
	ShortcutRefusedError,
	upsertProjectShortcut,
} from "../projects/project-shortcuts";
import { buildShortcutPortProxyPath, type ShortcutPortRegistry } from "../server/shortcut-ports";

export const shortcutAddRequestSchema = z.object({
	label: z.string().min(1),
	command: z.string().min(1),
	icon: z.string().min(1).nullable().optional(),
});
export const shortcutRemoveRequestSchema = z.object({ label: z.string().min(1) });
export const shortcutListResponseSchema = z.object({ shortcuts: z.array(runtimeProjectShortcutSchema) });

export const shortcutChangeResponseSchema = z.object({
	ok: z.boolean(),
	shortcuts: z.array(runtimeProjectShortcutSchema),
	/** What changed: null when nothing did (the same shortcut again). */
	change: z
		.object({
			label: z.string(),
			from: runtimeProjectShortcutSchema.optional(),
			to: runtimeProjectShortcutSchema.optional(),
		})
		.nullable(),
	error: z.string().optional(),
});
export type ShortcutChangeResponse = z.infer<typeof shortcutChangeResponseSchema>;

export const shortcutPrepareRunRequestSchema = z.object({
	label: z.string().min(1),
	/** The card whose terminal runs it; null = the board (the main checkout). */
	taskId: z.string().min(1).nullable(),
	/** The browser's origin, for `{url}` (the user reaches Kanban through a forwarded port, not the server's own). */
	origin: z.string().url(),
});
export const shortcutPrepareRunResponseSchema = z.object({
	ok: z.boolean(),
	/** The command to type, placeholders filled in. */
	command: z.string().nullable(),
	port: z.number().int().nullable(),
	url: z.string().nullable(),
	error: z.string().optional(),
});
export type ShortcutPrepareRunResponse = z.infer<typeof shortcutPrepareRunResponseSchema>;

export type ShortcutsCallerDecision = { allowed: true; actor: KitSettingsActor } | { allowed: false; message: string };

/** Who may change `workspaceId`'s shortcuts: the user and that project's own orchestrator. */
export function decideShortcutsCaller(caller: RuntimeCaller, workspaceId: string): ShortcutsCallerDecision {
	if (caller.kind === "user") {
		return { allowed: true, actor: { kind: "user" } };
	}
	if (caller.kind === "session" && caller.session.role === "orchestrator") {
		if (caller.session.workspaceId === workspaceId) {
			return { allowed: true, actor: { kind: "orchestrator", taskId: caller.session.taskId } };
		}
		return {
			allowed: false,
			message: `Shortcuts of ${workspaceId} are changed only by the user and ${workspaceId}'s own orchestrator, not ${describeCaller(caller)}. Send ${workspaceId}'s orchestrator a message (kanban message send).`,
		};
	}
	return {
		allowed: false,
		message: `A project's shortcuts are changed only by the user and the project's orchestrator; ${describeCaller(caller)} can't. Tell your orchestrator what you need.`,
	};
}

export interface ShortcutCallInput<Request> {
	caller: RuntimeCaller;
	workspaceId: string;
	repoPath: string;
	request: Request;
}

export interface RuntimeShortcutsApi {
	list: (repoPath: string) => Promise<z.infer<typeof shortcutListResponseSchema>>;
	add: (input: ShortcutCallInput<z.infer<typeof shortcutAddRequestSchema>>) => Promise<ShortcutChangeResponse>;
	remove: (input: ShortcutCallInput<z.infer<typeof shortcutRemoveRequestSchema>>) => Promise<ShortcutChangeResponse>;
	prepareRun: (
		input: ShortcutCallInput<z.infer<typeof shortcutPrepareRunRequestSchema>>,
	) => Promise<ShortcutPrepareRunResponse>;
}

export interface CreateShortcutsApiDependencies {
	log: IsolationService["log"];
	ports: ShortcutPortRegistry;
	/** Tells the workspace's browsers to reload the project config. */
	onChanged?: (workspaceId: string) => void;
	/** Tests: where the history goes. */
	historyPath?: string;
}

function failure(error: string): ShortcutChangeResponse {
	return { ok: false, shortcuts: [], change: null, error };
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createShortcutsApi(deps: CreateShortcutsApiDependencies): RuntimeShortcutsApi {
	const logRefusal = async (action: string, caller: RuntimeCaller, workspaceId: string, detail: string) => {
		await deps.log([workspaceId, caller.kind === "session" ? caller.session.workspaceId : null], {
			kind: "refused",
			taskId: caller.kind === "session" ? caller.session.taskId : null,
			from: caller.kind === "session" ? caller.session.workspaceId : null,
			to: workspaceId,
			action,
			detail: `${detail} (${caller.kind === "session" ? `${caller.session.role} via ${caller.via}` : caller.kind === "unknown" ? caller.reason : "user"})`,
		});
	};

	const run = async (
		action: "shortcuts.add" | "shortcuts.remove",
		input: ShortcutCallInput<{ label: string }>,
		changeShortcuts: (by: KitSettingsActor) => Promise<ShortcutChangeResult>,
	): Promise<ShortcutChangeResponse> => {
		const decision = decideShortcutsCaller(input.caller, input.workspaceId);
		if (!decision.allowed) {
			await logRefusal(
				action,
				input.caller,
				input.workspaceId,
				`shortcut "${input.request.label}": the user's and the project orchestrator's`,
			);
			return failure(decision.message);
		}
		try {
			const result = await changeShortcuts(decision.actor);
			if (result.change) {
				deps.onChanged?.(input.workspaceId);
			}
			return {
				ok: true,
				shortcuts: result.shortcuts,
				change: result.change
					? { label: result.change.label, from: result.change.from, to: result.change.to }
					: null,
			};
		} catch (error) {
			return failure(error instanceof ShortcutRefusedError ? error.message : toErrorMessage(error));
		}
	};

	return {
		list: async (repoPath) => ({ shortcuts: await loadProjectShortcuts(repoPath) }),
		add: async (input) =>
			await run(
				"shortcuts.add",
				input,
				async (by) =>
					await upsertProjectShortcut({
						workspaceId: input.workspaceId,
						repoPath: input.repoPath,
						by,
						shortcut: input.request,
						historyPath: deps.historyPath,
					}),
			),
		remove: async (input) =>
			await run(
				"shortcuts.remove",
				input,
				async (by) =>
					await removeProjectShortcut({
						workspaceId: input.workspaceId,
						repoPath: input.repoPath,
						by,
						label: input.request.label,
						historyPath: deps.historyPath,
					}),
			),
		prepareRun: async ({ caller, workspaceId, repoPath, request }) => {
			const refused = (error: string): ShortcutPrepareRunResponse => ({
				ok: false,
				command: null,
				port: null,
				url: null,
				error,
			});
			if (caller.kind !== "user") {
				await logRefusal(
					"shortcuts.prepareRun",
					caller,
					workspaceId,
					`port for shortcut "${request.label}": the user's click`,
				);
				return refused(
					`A shortcut's port is handed out for the user's click on the board, not to ${describeCaller(caller)}.`,
				);
			}
			const shortcut = (await loadProjectShortcuts(repoPath)).find((item) => item.label === request.label);
			if (!shortcut) {
				return refused(`${workspaceId} has no shortcut "${request.label}"`);
			}
			if (!shortcutNeedsPort(shortcut.command)) {
				return { ok: true, command: shortcut.command, port: null, url: null };
			}
			try {
				const { port } = await deps.ports.allocate({ workspaceId, taskId: request.taskId, label: shortcut.label });
				const url = `${new URL(request.origin).origin}${buildShortcutPortProxyPath(port)}`;
				return { ok: true, command: expandShortcutCommand(shortcut.command, { port, url }), port, url };
			} catch (error) {
				return refused(toErrorMessage(error));
			}
		},
	};
}
