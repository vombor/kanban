// The runtime side of a project's shortcuts (src/projects/project-shortcuts.ts, kept in the shortcut store
// src/projects/project-shortcut-store.ts) and of a shortcut run that asks for a port (`{port}` / `{url}`,
// src/config/shortcut-utils.ts). It is the only writer of the store: `kanban shortcut add|remove` and the board's
// settings dialog (`shortcuts.replace`) both come here. Who may change a project's shortcuts is decided here with
// the strict caller lookup (a session without its credential is traced to its process tree), in every isolation
// mode, off included, by the kit settings' rule: the user (the user's browser included) and that workspace's own
// orchestrator; a card, another workspace's orchestrator and an unidentified caller are refused. A change is pushed
// to the browser (`project_shortcuts_updated`), which reloads the project config. A run's port is the user's click
// on the board: only the user gets one.
import { z } from "zod";
import { expandShortcutCommand, shortcutNeedsPort } from "../config/shortcut-utils";
import { runtimeProjectShortcutSchema } from "../core/api-contract";
import type { IsolationService } from "../isolation/isolation-service";
import { describeCaller, type RuntimeCaller } from "../isolation/session-identity";
import type { KitSettingsActor } from "../kits/project-settings";
import { readProjectShortcuts } from "../projects/project-shortcut-store";
import {
	removeProjectShortcut,
	replaceProjectShortcuts,
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
/** The settings dialog's save: the whole list in its order (rows without a label or command are dropped). */
export const shortcutReplaceRequestSchema = z.object({
	shortcuts: z.array(z.object({ label: z.string(), command: z.string(), icon: z.string().nullable().optional() })),
});
export const shortcutListResponseSchema = z.object({ shortcuts: z.array(runtimeProjectShortcutSchema) });

const shortcutChangeSchema = z.object({
	label: z.string(),
	from: runtimeProjectShortcutSchema.optional(),
	to: runtimeProjectShortcutSchema.optional(),
});

export const shortcutChangeResponseSchema = z.object({
	ok: z.boolean(),
	shortcuts: z.array(runtimeProjectShortcutSchema),
	/** What changed: null when nothing did (the same shortcut again); a replace's first change. */
	change: shortcutChangeSchema.nullable(),
	/** Every shortcut that changed, one per label. */
	changes: z.array(shortcutChangeSchema),
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
	list: (input: { workspaceId: string; repoPath: string }) => Promise<z.infer<typeof shortcutListResponseSchema>>;
	add: (input: ShortcutCallInput<z.infer<typeof shortcutAddRequestSchema>>) => Promise<ShortcutChangeResponse>;
	remove: (input: ShortcutCallInput<z.infer<typeof shortcutRemoveRequestSchema>>) => Promise<ShortcutChangeResponse>;
	replace: (input: ShortcutCallInput<z.infer<typeof shortcutReplaceRequestSchema>>) => Promise<ShortcutChangeResponse>;
	prepareRun: (
		input: ShortcutCallInput<z.infer<typeof shortcutPrepareRunRequestSchema>>,
	) => Promise<ShortcutPrepareRunResponse>;
}

export interface CreateShortcutsApiDependencies {
	log: IsolationService["log"];
	ports: ShortcutPortRegistry;
	/** Tells the workspace's browsers to reload the project config. */
	onChanged?: (workspaceId: string) => void;
	/** Tests: the Kanban home the shortcut store and its history are in. */
	homePath?: string;
	/** Tests: the base branch the one-time import reads. */
	resolveBaseBranch?: () => Promise<string | null>;
}

export function shortcutsUnavailableResponse(): ShortcutChangeResponse {
	return failure("Shortcuts are not available here.");
}

function failure(error: string): ShortcutChangeResponse {
	return { ok: false, shortcuts: [], change: null, changes: [], error };
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

	const store = (input: { workspaceId: string; repoPath: string }) => ({
		workspaceId: input.workspaceId,
		repoPath: input.repoPath,
		homePath: deps.homePath,
		resolveBaseBranch: deps.resolveBaseBranch,
	});

	const run = async <Request>(
		action: "shortcuts.add" | "shortcuts.remove" | "shortcuts.replace",
		input: ShortcutCallInput<Request>,
		what: string,
		changeShortcuts: (by: KitSettingsActor) => Promise<ShortcutChangeResult>,
	): Promise<ShortcutChangeResponse> => {
		const decision = decideShortcutsCaller(input.caller, input.workspaceId);
		if (!decision.allowed) {
			await logRefusal(
				action,
				input.caller,
				input.workspaceId,
				`${what}: the user's and the project orchestrator's`,
			);
			return failure(decision.message);
		}
		try {
			const result = await changeShortcuts(decision.actor);
			if (result.changes.length > 0) {
				deps.onChanged?.(input.workspaceId);
			}
			const changes = result.changes.map((entry) => ({ label: entry.label, from: entry.from, to: entry.to }));
			return { ok: true, shortcuts: result.shortcuts, change: changes[0] ?? null, changes };
		} catch (error) {
			return failure(error instanceof ShortcutRefusedError ? error.message : toErrorMessage(error));
		}
	};

	return {
		list: async (input) => ({ shortcuts: await readProjectShortcuts(store(input)) }),
		add: async (input) =>
			await run(
				"shortcuts.add",
				input,
				`shortcut "${input.request.label}"`,
				async (by) => await upsertProjectShortcut({ ...store(input), by, shortcut: input.request }),
			),
		remove: async (input) =>
			await run(
				"shortcuts.remove",
				input,
				`shortcut "${input.request.label}"`,
				async (by) => await removeProjectShortcut({ ...store(input), by, label: input.request.label }),
			),
		replace: async (input) =>
			await run(
				"shortcuts.replace",
				input,
				"the shortcut list",
				async (by) => await replaceProjectShortcuts({ ...store(input), by, shortcuts: input.request.shortcuts }),
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
			const shortcut = (await readProjectShortcuts(store({ workspaceId, repoPath }))).find(
				(item) => item.label === request.label,
			);
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
