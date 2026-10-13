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
//   A live sidebar whose user is working in it gets the wake silently instead (decideWakeDelivery,
//   `orchestrator.wake.delivery`): the server queues it in the workspace's orchestrator inbox and the sidebar agent takes
//   it with the user's next prompt through its prompt hook (src/server/orchestrator-inbox.ts); unread, it is typed
//   `quietMin` later. A queue that fails falls back to typing.
// Typing that fails leaves the items due with no cooldown (queued items are kept in `wakeRetry`); text that was typed
// but whose Enter showed no activity gets only an Enter on the next tick (`wakeEnter`), so it is never typed twice.
//
// Ported from kit main 00514f2 lib/sidebar-wake.cjs (after the archive cut at 6da71597; wakeKey, pickFresh, markWoken,
// keepForRetry, wakeText, wake) and archive/devteam-kit:services/review-watch.mjs@6da71597 (wakeOrchestrator). The
// legacy fallback "typing failed twice → headless" is dropped: it started a second orchestrator beside a live sidebar.
import type { OrchestratorWakeDelivery, OrchestratorWakePresentation } from "../../config/pipeline-config";
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

/**
 * True when the orchestrator sidebar session can take typed input. `live: false` (the server's own answer: no
 * process) wins over a pid: a summary hydrated after a restart keeps the dead process's pid in every state but
 * "running" (only those are marked interrupted), so a wake would be typed into nothing, tick after tick.
 */
export function isOrchestratorSessionLive(session: PipelineSessionView | null | undefined): boolean {
	return Boolean(
		session &&
			session.live !== false &&
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
	/** When the user last typed into the orchestrator sidebar (epoch ms), or null. */
	userTypedAt?: number | null;
	presentation?: OrchestratorWakePresentation;
	/** Full notice persisted before a shortened wake is delivered. */
	noticeLogPath?: string;
}

/** The user typed into the sidebar this recently: the wake must not say nobody is watching (issue #35). */
export const WAKE_USER_ACTIVE_MS = 30 * 60_000;

/** Who may be reading the wake: nobody, unless the user typed into the sidebar within WAKE_USER_ACTIVE_MS. */
export function describeWakeAudience(userTypedAt: number | null | undefined, now: number): string {
	if (userTypedAt === null || userTypedAt === undefined || now - userTypedAt >= WAKE_USER_ACTIVE_MS) {
		return "no human is watching";
	}
	const minutes = Math.max(0, Math.floor((now - userTypedAt) / 60_000));
	return `the user typed in this sidebar ${minutes < 1 ? "under a minute" : `${minutes} min`} ago and may be reading`;
}

export interface WakeDeliveryInput {
	policy: OrchestratorWakeDelivery;
	/** The sidebar's agent takes queued notices with the next prompt (orchestrator-agents.ts agentTakesSilentNotices). */
	agentTakesSilentNotices: boolean;
	/** When the user last typed into the sidebar (epoch ms), or null. */
	userTypedAt: number | null | undefined;
	now: number;
	quietMs: number;
	/** Some item needs the user or an answer now (a card waiting for approval, an outage escalation, a stop). */
	urgent: boolean;
}

export interface WakeDeliveryDecision {
	silent: boolean;
	reason: string;
}

/**
 * Whether a wake into a live sidebar is queued silently for the agent's next prompt or typed as a prompt. `silent`
 * queues every wake, `type` none; `auto` queues while the user typed in the sidebar within `quietMs`, unless an item
 * is urgent (typed at once, so the orchestrator acts without the user).
 */
export function decideWakeDelivery(input: WakeDeliveryInput): WakeDeliveryDecision {
	if (!input.agentTakesSilentNotices) {
		return { silent: false, reason: "the sidebar's agent has no prompt hook for queued notices" };
	}
	if (input.policy === "type") {
		return { silent: false, reason: "delivery type" };
	}
	if (input.policy === "silent") {
		return { silent: true, reason: "delivery silent" };
	}
	if (input.urgent) {
		return { silent: false, reason: "an item needs the user or an answer now" };
	}
	const typedAt = input.userTypedAt ?? null;
	if (typedAt !== null && input.now - typedAt < input.quietMs) {
		return { silent: true, reason: "the user is working in the sidebar" };
	}
	return { silent: false, reason: "the user hasn't typed in the sidebar recently" };
}

/** One line: which workspace and project, the items, and where to look. */
export function buildWakeText(input: WakeTextInput): string {
	if (input.presentation && input.presentation !== "full" && input.noticeLogPath) {
		const prefix = `[kanban watchdog] ${input.workspaceId}: ${input.items.length} notice(s)`;
		const summary =
			input.presentation === "compact"
				? `: ${input.items
						.slice(0, 3)
						.map((item) => {
							const clean = cleanItem(item);
							return clean.length > 140 ? `${clean.slice(0, 137)}…` : clean;
						})
						.join(" | ")}${input.items.length > 3 ? ` | +${input.items.length - 3} more` : ""}`
				: "";
		return `${prefix}${summary}. Read the full wake notice at ${input.now.toISOString()} in ${input.noticeLogPath}; handle orchestration yourself, leaving only product/budget decisions for the user.`;
	}
	const where = [
		`ATTENTION ${input.attentionPath}`,
		`pipeline decisions ${input.decisionsPath}`,
		`QA log ${input.qaLogPath}`,
	].join(", ");
	return `[kanban watchdog ${input.now.toISOString().slice(11, 16)}Z] workspace ${input.workspaceId} (${input.projectPath}) needs the orchestrator; ${describeWakeAudience(input.userTypedAt, input.now.getTime())}: ${input.items.map(cleanItem).join(" | ")} . Assess it (${where}; kanban CLI calls for it need --project-path ${input.projectPath}), fix orchestration problems yourself, apply the standing rules for model/benchmark decisions, and leave only real product/budget decisions for the user.`.replace(
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

/** Where a wake goes (wakeOrchestrator below): never zero orchestrators and never two. */
export type WakeRoute =
	/** A headless run is going: the items go into its queue. */
	| "headless-queue"
	/** The sidebar session is live: the text is typed into it. */
	| "sidebar"
	/** A new headless run. */
	| "headless"
	/** The sidebar session is started server-side with the text as its first input. */
	| "start-sidebar";

export function planWakeRoute(input: {
	headlessPid: number;
	session: PipelineSessionView | null;
	mode: WakeMode;
	hasHeadlessRunner: boolean;
}): WakeRoute {
	if (input.headlessPid) {
		return "headless-queue";
	}
	if (isOrchestratorSessionLive(input.session)) {
		return "sidebar";
	}
	return input.mode === "headless" && input.hasHeadlessRunner ? "headless" : "start-sidebar";
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
	/** Queues the wake in the sidebar's inbox for the agent's next prompt, typed as `text` at `typeAfter` if unread. */
	queueSilent?: (
		items: readonly string[],
		text: string,
		typeAfter: number,
	) => Promise<{ ok: boolean; pending: number; error?: string }>;
	startSession: (prompt: string) => Promise<{ ok: boolean; error?: string }>;
}

export type WakePath =
	| "none"
	| "queued"
	| "sidebar"
	| "sidebar-silent"
	| "sidebar-enter"
	| "sidebar-started"
	| "headless"
	| "retry";

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
	text: (items: readonly string[]) => string | Promise<string>;
	now: number;
	cooldownMs: number;
	retryMs: number;
	/** How a wake into the live sidebar is delivered (decideWakeDelivery for these items); absent = typed. */
	delivery?: (items: readonly string[]) => WakeDeliveryDecision;
	/** How long a silent notice waits unread before it is typed. */
	quietMs?: number;
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
	const route = planWakeRoute({
		headlessPid: pid,
		session: target.session,
		mode: input.mode,
		hasHeadlessRunner: deps.hasHeadlessRunner,
	});
	if (route === "headless-queue") {
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

	if (route === "sidebar") {
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
		const decision = input.delivery?.(fresh) ?? null;
		const text = await input.text(fresh);
		let fallback = "";
		if (decision?.silent && deps.queueSilent) {
			const queued = await deps
				.queueSilent(fresh, text, now + (input.quietMs ?? WAKE_USER_ACTIVE_MS))
				.catch((error: unknown) => ({ ok: false, pending: 0, error: String(error) }));
			if (queued.ok) {
				markWoken(state, fresh, now);
				return {
					path: "sidebar-silent",
					ok: true,
					items: fresh,
					detail: `queued silently for ${target.sessionId}'s next prompt (${decision.reason}; ${queued.pending} pending, typed in ${Math.round((input.quietMs ?? WAKE_USER_ACTIVE_MS) / 60_000)} min if unread)`,
				};
			}
			fallback = `; the silent queue failed (${queued.error ?? "?"}), so it was typed`;
		}
		const result = await deps.deliver(text);
		if (result.ok) {
			markWoken(state, fresh, now);
			const detail = `${
				result.status === "queued"
					? `held for ${target.sessionId} while the user types there; typed once their input clears`
					: `typed into ${target.sessionId}: ${result.status}`
			}${decision && !decision.silent ? ` (${decision.reason})` : ""}${fallback}`;
			return { path: "sidebar", ok: true, items: fresh, detail };
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
	if (route === "headless") {
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
	const started = await deps.startSession(await input.text(fresh));
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
