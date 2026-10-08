// Waking the orchestrator: the agent selected in Kanban settings, in the sidebar session
// `createHomeAgentSessionId(<ws>, <selected agent>)` of the workspace the items are about (never a hard-coded agent,
// plan §4.0 rule 4; never another workspace's, docs/fork/watchdog-isolation.md), or a headless run of that agent.
//
// Never zero orchestrators and never two (user, 2026-10-07):
//   - a headless run for the target is going (its lock pid is alive)  → the items go into its queue; it handles them
//     as a follow-up run. Nothing else is started.
//   - the sidebar session is live (a summary with a pid, not failed/interrupted) → the text is typed into it
//     (deliverTaskInput: text, Enter, activity check). A headless run is never started beside a live sidebar.
//   - neither: `orchestrator.wake.mode` "headless" and the agent has a headless runner → a headless run; otherwise
//     the sidebar session is started server-side with the text as its first input. Only a browser starts it
//     otherwise (web-ui use-home-agent-session.ts), so after a Kanban restart there may be none.
// Typing that fails leaves the items due with no cooldown (queued items are kept in `wakeRetry`); text that was typed
// but whose Enter showed no activity gets only an Enter on the next tick (`wakeEnter`), so it is never typed twice.
//
// Ported from kit main 00514f2 lib/sidebar-wake.cjs (after the archive cut at 6da71597; wakeKey, pickFresh, markWoken,
// keepForRetry, wakeText, wake) and archive/devteam-kit:services/review-watch.mjs@6da71597 (wakeOrchestrator). The
// legacy fallback "typing failed twice → headless" is dropped: it started a second orchestrator beside a live sidebar.
import type { RuntimeAgentId, RuntimeTaskInputDeliveryResponse } from "../../core/api-contract";
import type { PipelineSessionView } from "../engine";
import type { WatchdogWorkspaceState } from "./watchdog-state";

export type WakeMode = "headless" | "sidebar";

/** Cooldown key: the item without timestamps (they change every tick), capped. */
export function wakeKey(item: string): string {
	return item.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/gu, "").slice(0, 160);
}

function cleanItem(item: string): string {
	return item
		.replace(/^- /u, "")
		.replace(/\*\*/gu, "")
		.replace(/\s*\n\s*/gu, " ");
}

/** True when the orchestrator sidebar session can take typed input. */
export function isOrchestratorSessionLive(session: PipelineSessionView | null | undefined): boolean {
	return Boolean(
		session &&
			session.pid !== null &&
			session.pid !== undefined &&
			session.state !== "failed" &&
			session.state !== "interrupted",
	);
}

export interface WakeTextInput {
	workspaceId: string;
	projectPath: string;
	attentionPath: string;
	decisionsPath: string;
	qaLogPath: string;
	items: readonly string[];
	now: Date;
}

/** One line: which workspace and project, the items, and where to look. */
export function buildWakeText(input: WakeTextInput): string {
	const where = [
		`ATTENTION ${input.attentionPath}`,
		`pipeline decisions ${input.decisionsPath}`,
		`QA log ${input.qaLogPath}`,
	].join(", ");
	return `[kanban watchdog ${input.now.toISOString().slice(11, 16)}Z] workspace ${input.workspaceId} (${input.projectPath}) needs the orchestrator; no human is watching: ${input.items.map(cleanItem).join(" | ")} . Assess it (${where}; kanban CLI calls for it need --project-path ${input.projectPath}), fix orchestration problems yourself, apply the standing rules for model/benchmark decisions, and leave only real product/budget decisions for the user.`.replace(
		/\s*\n\s*/gu,
		" ",
	);
}

/**
 * Items not woken within `cooldownMs`: this tick's items plus the queued ones a failed wake kept (dropped after
 * `retryMs`; by then the detector queues them again if they still hold). Deduplicated by wakeKey; not marked.
 */
export function pickFreshWakeItems(
	state: WatchdogWorkspaceState,
	items: readonly string[],
	options: { now: number; cooldownMs: number; retryMs: number },
): string[] {
	state.wakeRetry = state.wakeRetry.filter((entry) => options.now - Date.parse(entry.at) < options.retryMs);
	const seen = new Set<string>();
	return [...items, ...state.wakeRetry.map((entry) => entry.item)].filter((item) => {
		const key = wakeKey(item);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		const last = state.woken[key];
		return !(last && options.now - Date.parse(last) < options.cooldownMs);
	});
}

export function markWoken(state: WatchdogWorkspaceState, items: readonly string[], now: number): void {
	const at = new Date(now).toISOString();
	for (const item of items) {
		state.woken[wakeKey(item)] = at;
	}
	const done = new Set(items.map(wakeKey));
	state.wakeRetry = state.wakeRetry.filter((entry) => !done.has(wakeKey(entry.item)));
}

/** Keeps the items that only came from a queue (not recomputed each tick, unlike ATTENTION items) for the next tick. */
export function keepForRetry(
	state: WatchdogWorkspaceState,
	items: readonly string[],
	queued: readonly string[],
	now: number,
): void {
	const fromQueue = new Set(queued.map(wakeKey));
	const kept = new Set(state.wakeRetry.map((entry) => wakeKey(entry.item)));
	for (const item of items) {
		const key = wakeKey(item);
		if (fromQueue.has(key) && !kept.has(key)) {
			state.wakeRetry.push({ item, at: new Date(now).toISOString() });
			kept.add(key);
		}
	}
}

export interface WakeTarget {
	workspaceId: string;
	projectPath: string;
	agentId: RuntimeAgentId;
	/** createHomeAgentSessionId(workspaceId, agentId). */
	sessionId: string;
	session: PipelineSessionView | null;
}

export interface WakeDependencies {
	/** Pid of the target's headless run if its lock holds a live process, -1 for one just started, else 0. */
	headlessPid: () => number;
	hasHeadlessRunner: boolean;
	/** Appends items to the running headless run's queue. */
	queueForHeadless: (items: readonly string[]) => Promise<void>;
	/** Queues the items and starts a headless run. */
	startHeadless: (items: readonly string[]) => Promise<{ ok: boolean; error?: string }>;
	deliver: (text: string) => Promise<RuntimeTaskInputDeliveryResponse>;
	startSession: (prompt: string) => Promise<{ ok: boolean; error?: string }>;
}

export type WakePath = "none" | "queued" | "sidebar" | "sidebar-enter" | "sidebar-started" | "headless" | "retry";

export interface WakeOutcome {
	path: WakePath;
	ok: boolean;
	items: string[];
	detail: string;
}

export interface WakeInput {
	state: WatchdogWorkspaceState;
	/** This tick's items (ATTENTION items and queued issues). */
	items: readonly string[];
	/** The subset of `items` that came from a queue (kept for retry when the wake fails). */
	queued: readonly string[];
	target: WakeTarget;
	mode: WakeMode;
	text: (items: readonly string[]) => string;
	now: number;
	cooldownMs: number;
	retryMs: number;
	deps: WakeDependencies;
}

export async function wakeOrchestrator(input: WakeInput): Promise<WakeOutcome> {
	const { state, target, deps, now } = input;
	const fresh = pickFreshWakeItems(state, input.items, {
		now,
		cooldownMs: input.cooldownMs,
		retryMs: input.retryMs,
	});
	if (fresh.length === 0 && !state.wakeEnter) {
		return { path: "none", ok: true, items: [], detail: "nothing due" };
	}

	const pid = deps.headlessPid();
	if (pid) {
		if (fresh.length === 0) {
			return {
				path: "none",
				ok: true,
				items: [],
				detail: `headless run ${pid > 0 ? pid : "(just started)"} active`,
			};
		}
		await deps.queueForHeadless(fresh);
		markWoken(state, fresh, now);
		return {
			path: "queued",
			ok: true,
			items: fresh,
			detail: `queued for the running headless run ${pid > 0 ? pid : "(just started)"}`,
		};
	}

	if (isOrchestratorSessionLive(target.session)) {
		const pending = state.wakeEnter;
		if (pending && (pending.taskId !== target.sessionId || now - Date.parse(pending.at) >= input.retryMs)) {
			state.wakeEnter = null;
		}
		if (state.wakeEnter) {
			const enter = state.wakeEnter;
			const result = await deps.deliver("");
			keepForRetry(state, fresh, input.queued, now);
			if (result.ok) {
				markWoken(state, enter.items, now);
				state.wakeEnter = null;
			}
			return {
				path: "sidebar-enter",
				ok: result.ok,
				items: enter.items,
				detail: `Enter only for the text typed last time: ${result.status}${result.error ? ` (${result.error})` : ""}`,
			};
		}
		if (fresh.length === 0) {
			return { path: "none", ok: true, items: [], detail: "nothing due" };
		}
		const result = await deps.deliver(input.text(fresh));
		if (result.ok) {
			markWoken(state, fresh, now);
			return { path: "sidebar", ok: true, items: fresh, detail: `typed into ${target.sessionId}: ${result.status}` };
		}
		keepForRetry(state, fresh, input.queued, now);
		if (result.status === "undelivered") {
			state.wakeEnter = { taskId: target.sessionId, at: new Date(now).toISOString(), items: fresh };
		}
		return {
			path: "retry",
			ok: false,
			items: fresh,
			detail: `typing into ${target.sessionId} failed (${result.status}${result.error ? `: ${result.error}` : ""}); retried next tick${state.wakeEnter ? " (Enter only)" : ""}`,
		};
	}

	state.wakeEnter = null;
	if (fresh.length === 0) {
		return { path: "none", ok: true, items: [], detail: "nothing due" };
	}
	if (input.mode === "headless" && deps.hasHeadlessRunner) {
		const started = await deps.startHeadless(fresh);
		if (started.ok) {
			markWoken(state, fresh, now);
			return { path: "headless", ok: true, items: fresh, detail: `headless run started for ${target.agentId}` };
		}
		keepForRetry(state, fresh, input.queued, now);
		return {
			path: "retry",
			ok: false,
			items: fresh,
			detail: `headless run failed to start: ${started.error ?? "?"}`,
		};
	}
	const started = await deps.startSession(input.text(fresh));
	if (started.ok) {
		markWoken(state, fresh, now);
		return {
			path: "sidebar-started",
			ok: true,
			items: fresh,
			detail: `no live sidebar; started ${target.sessionId} with the wake as its first input${input.mode === "headless" ? ` (${target.agentId} has no headless runner)` : ""}`,
		};
	}
	keepForRetry(state, fresh, input.queued, now);
	return {
		path: "retry",
		ok: false,
		items: fresh,
		detail: `could not start ${target.sessionId}: ${started.error ?? "?"}; retried next tick`,
	};
}
