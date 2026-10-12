// Silent watchdog wakes (user request 2026-10-12: "have kanban message you silently so it doesn't interrupt what I'm
// typing"). While the user works in a workspace's orchestrator sidebar, the watchdog asks for a wake to be queued here
// instead of typed (`queueOrchestratorNotices`, src/pipeline/watchdog/wake.ts decideWakeDelivery). The sidebar's agent
// takes the queue with the user's next prompt through its prompt hook (Claude Code `UserPromptSubmit`, `kanban hooks
// orchestrator-notices`, tRPC `orchestratorInbox.take`), so the model sees the items without anything appearing in
// the input box. Whatever is still unread at its `typeAfter` is typed into the sidebar as a wake, through the
// typed-input hold (so never into the user's draft): nothing waits forever. An entry whose sidebar has no process is
// kept until `maxHoldMs` past its `typeAfter`, then dropped with a log line; by then the watchdog has decided again on
// whatever still holds. The file (src/state/orchestrator-inbox.ts) is per workspace and this module is its one writer.
import { existsSync } from "node:fs";

import type { RuntimeTaskInputDeliveryResponse } from "../core/api-contract";
import { isHomeAgentSessionIdForWorkspace } from "../core/home-agent-session";
import {
	getOrchestratorInboxPath,
	type OrchestratorInboxEntry,
	readOrchestratorInbox,
	updateOrchestratorInbox,
} from "../state/orchestrator-inbox";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { DEFAULT_TYPED_INPUT_HOLD_MAX_MS, mergeHeldWakeTexts, type TypedInputHold } from "./typed-input-hold";

export interface OrchestratorInboxDependencies {
	/** The workspace's terminal manager, or null when it isn't loaded. */
	getTerminal: (workspaceId: string) => Pick<TerminalSessionManager, "hasLiveProcess"> | null;
	hold: Pick<TypedInputHold, "deliver">;
	/** Workspaces whose inboxes the overdue sweep looks at (the loaded ones). */
	listWorkspaceIds: () => string[];
	log: (message: string) => void;
	now?: () => number;
	/** The inbox file of a workspace (tests: a temp home). */
	getPath?: (workspaceId: string) => string;
	/** How long an overdue entry waits for a sidebar with a process before it is dropped. */
	maxHoldMs?: number;
}

export interface OrchestratorInboxQueueInput {
	workspaceId: string;
	taskId: string;
	items: readonly string[];
	text: string;
	/** Epoch ms: typed into the sidebar if no prompt took it by then. */
	typeAfter: number;
}

export interface OrchestratorInbox {
	queue: (input: OrchestratorInboxQueueInput) => Promise<{ ok: boolean; pending: number; error?: string }>;
	/** Takes every entry of the workspace (the sidebar's prompt hook). */
	take: (workspaceId: string) => Promise<OrchestratorInboxEntry[]>;
	status: (workspaceId: string) => Promise<{ pending: number; oldestAt: string | null }>;
	/** Types the entries whose `typeAfter` has passed; returns how many wakes were handed to the sidebar. */
	flushOverdue: () => Promise<number>;
	start: (intervalMs?: number) => void;
	close: () => void;
}

/** The text reached the sidebar or waits in the typed-input hold (`undelivered`: typed, but no Enter seen). */
const DELIVERED = new Set<RuntimeTaskInputDeliveryResponse["status"]>(["delivered", "sent", "undelivered", "queued"]);

export function createOrchestratorInbox(deps: OrchestratorInboxDependencies): OrchestratorInbox {
	const now = deps.now ?? Date.now;
	const getPath = deps.getPath ?? ((workspaceId: string) => getOrchestratorInboxPath(workspaceId));
	const maxHoldMs = deps.maxHoldMs ?? DEFAULT_TYPED_INPUT_HOLD_MAX_MS;
	let timer: NodeJS.Timeout | null = null;
	let flushing: Promise<number> | null = null;

	const flushWorkspace = async (workspaceId: string): Promise<number> => {
		const path = getPath(workspaceId);
		if (!existsSync(path)) {
			return 0;
		}
		const at = now();
		const terminal = deps.getTerminal(workspaceId);
		const due = await updateOrchestratorInbox(path, workspaceId, (entries) => {
			const overdue = entries.filter((entry) => Date.parse(entry.typeAfter) <= at);
			const last = overdue.at(-1);
			if (!last) {
				return { entries, result: null };
			}
			if (terminal?.hasLiveProcess(last.taskId)) {
				return { entries: entries.filter((entry) => !overdue.includes(entry)), result: overdue };
			}
			const expired = overdue.filter((entry) => at - Date.parse(entry.typeAfter) >= maxHoldMs);
			if (expired.length > 0) {
				deps.log(
					`[orchestrator-inbox] ${workspaceId}: dropped ${expired.length} unread notice(s) for ${last.taskId}: the sidebar has had no process since they were due`,
				);
			}
			return { entries: entries.filter((entry) => !expired.includes(entry)), result: null };
		});
		if (!due) {
			return 0;
		}
		const taskId = due.at(-1)?.taskId ?? "";
		const result = await deps.hold
			.deliver(workspaceId, taskId, mergeHeldWakeTexts(due.map((entry) => entry.text)))
			.catch((error: unknown) => ({ ok: false, status: "error" as const, error: String(error) }));
		if (!DELIVERED.has(result.status)) {
			// Nothing reached the sidebar: back to the front of the inbox for the next sweep.
			await updateOrchestratorInbox(path, workspaceId, (entries) => ({
				entries: [...due, ...entries],
				result: null,
			}));
			deps.log(
				`[orchestrator-inbox] ${workspaceId}: typing ${due.length} unread notice(s) into ${taskId} failed (${result.status}${"error" in result && result.error ? `: ${result.error}` : ""}); kept`,
			);
			return 0;
		}
		deps.log(
			`[orchestrator-inbox] ${workspaceId}: ${due.length} notice(s) unread since they were due; typed into ${taskId}: ${result.status}`,
		);
		return 1;
	};

	const flushOnce = async (): Promise<number> => {
		let typed = 0;
		for (const workspaceId of deps.listWorkspaceIds()) {
			typed += await flushWorkspace(workspaceId).catch((error: unknown) => {
				deps.log(`[orchestrator-inbox] ${workspaceId}: overdue sweep failed: ${String(error)}`);
				return 0;
			});
		}
		return typed;
	};

	const flushOverdue = async (): Promise<number> => {
		// One sweep at a time: a slow delivery must not type the same notices twice.
		flushing ??= flushOnce().finally(() => {
			flushing = null;
		});
		return await flushing;
	};

	return {
		queue: async (input) => {
			// The inbox is the workspace's own orchestrator's: never another workspace's session.
			if (!isHomeAgentSessionIdForWorkspace(input.taskId, input.workspaceId)) {
				return {
					ok: false,
					pending: 0,
					error: `${input.taskId} is not ${input.workspaceId}'s orchestrator session.`,
				};
			}
			const entry: OrchestratorInboxEntry = {
				workspaceId: input.workspaceId,
				taskId: input.taskId,
				at: new Date(now()).toISOString(),
				typeAfter: new Date(input.typeAfter).toISOString(),
				items: [...input.items],
				text: input.text,
			};
			const pending = await updateOrchestratorInbox(getPath(input.workspaceId), input.workspaceId, (entries) => ({
				entries: [...entries, entry],
				result: entries.length + 1,
			}));
			return { ok: true, pending };
		},
		take: async (workspaceId) =>
			await updateOrchestratorInbox(getPath(workspaceId), workspaceId, (entries) => ({
				entries: [],
				result: entries,
			})),
		status: async (workspaceId) => {
			const entries = await readOrchestratorInbox(getPath(workspaceId), workspaceId);
			return { pending: entries.length, oldestAt: entries[0]?.at ?? null };
		},
		flushOverdue,
		start: (intervalMs = 15_000) => {
			if (timer) {
				return;
			}
			timer = setInterval(() => {
				void flushOverdue().catch(() => 0);
			}, intervalMs);
			timer.unref();
		},
		close: () => {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
