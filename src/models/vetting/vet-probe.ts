// The agent-specific failure detectors `kanban models vet` watches a run with, reusing recovery's readers: for agents
// whose turns Kanban reads from Cline's session files (getAgentTurnEndSource), the silent stall and `no_session`
// (evaluateClineSilentStall), a hung model request (detectHungRequest), and a turn that ended on a provider error or a
// context overflow (detectFinalProviderError). Other agents answer null here; the runner's own checks (no turn
// started, no progress, session failed, caps) still apply to them.
//
// Where the probe answers, it owns the run's silence: the runner's generic "no progress" check doesn't apply. The first
// runs (2026-10-09, three Lemonade models loading at once) failed for harness reasons, so the probe never counts
// what the environment does as the model's silence: a model Lemonade is still loading (/api/v1/health), the first
// reply of a slow-first-call provider (CLINE_FIRST_REPLY_LOAD_ALLOWANCE_MS), a model request in flight before the
// hung check's limit, and a shell tool whose command still runs (findAgentToolProcess). A provider timeout on a local
// provider is `provider_timeout`, which the runner retries; it and the other environment failures are `harness`.
//
// A turn that ends on a provider or transport error says nothing about the model (issue #25, 2026-10-10: five runs
// got only Lemonade's "No model loaded: <model>" after another project's card evicted the model, two a "Context size
// has been exceeded." from an instance shared with notes' QA): a context overflow, and any error notice Cline shows in
// place of a reply (`displayError`: "No model loaded", "Response stream ended without a finish reason."), are
// `harness` too, so the run is inconclusive, never a rejection. A rejected request (a validation error over a
// malformed tool call in the history) stays the model's.

import type { RuntimeAgentId } from "../../core/api-contract";
import { isLocalProvider } from "../../kits/team/bench/prices";
import {
	detectFinalProviderError,
	detectHungRequest,
	isContextOverflowError,
	isPoisonedHistoryError,
	isTransientProviderError,
} from "../../pipeline/recovery-detect";
import type { AgentToolProcessFinder } from "../../server/process-reaper";
import { getClineDataDirPath } from "../../state/kanban-home";
import { getAgentTurnEndSource } from "../../terminal/agent-session-adapters";
import {
	type ClineSessionDetailMessage,
	type ClineSessionDetailReader,
	createClineSessionFileReader,
	getClineSessionsPath,
} from "../../terminal/cline-session-files";
import {
	CLINE_FIRST_REPLY_LOAD_ALLOWANCE_MS,
	describeClineSilentStall,
	evaluateClineSilentStall,
} from "../../terminal/cline-turn-check";
import { LEMONADE_PROVIDER_ID } from "../model-probe";

export type VetFailureKind =
	| "sign_in"
	| "no_session"
	| "image_rejection"
	| "text_tool_calls"
	| "tool_loop"
	| "silent_stall"
	| "hung_request"
	| "context_overflow"
	| "provider_error"
	| "provider_timeout"
	| "session_failed"
	| "time_cap"
	| "cost_cap"
	/** The provider stayed at its `models.providerCapacity` limit for the whole wait: no card was created. */
	| "capacity"
	| "task";

export interface VetFailure {
	kind: VetFailureKind;
	detail: string;
	/**
	 * Caused by the harness or the environment (sign-in, provider, Kanban), not by the model: the proposal is then
	 * `provisional` with the reason, never `rejected` (vet-report.ts).
	 */
	harness?: boolean;
	/** `provider_timeout` only: which error this is (session + message count), so one error is retried once. */
	occurrence?: string;
}

export interface VetProbeInput {
	agentId: RuntimeAgentId;
	worktreePath: string;
	providerId: string | null;
	model: string | null;
	/** The card session's process, whose descendants run its shell tools. */
	agentPid: number | null;
	runStartedAt: number;
	/** Kanban's newest sign of progress (hooks, state changes, scratch repo writes). */
	kanbanProgressAt: number;
	stallMin: number;
	now: number;
}

export interface VetProbeVerdict {
	failure: VetFailure | null;
	/** What keeps the run's silence from being judged right now (for the run log), or null. */
	hold: string | null;
}

export interface VetProbeOptions {
	clineDataDir?: string | null;
	hungMin?: number;
	reader?: ClineSessionDetailReader;
	/** Whether Lemonade has the model loaded (fetchLemonadeModelLoaded), null when it can't be told. */
	isLemonadeModelLoaded?: (model: string) => Promise<boolean | null>;
	findRunningTool?: AgentToolProcessFinder;
}

const TIMEOUT_PATTERN = /timed out|timeout|ETIMEDOUT/i;

export function isProviderTimeoutError(text: string): boolean {
	return TIMEOUT_PATTERN.test(text);
}

/** The text of the session's last message when it is Cline's own error notice in place of a reply, else null. */
export function readFinalClineErrorNotice(messages: readonly ClineSessionDetailMessage[]): string | null {
	const last = messages.at(-1);
	if (!last?.displayError || last.role !== "assistant" || last.content.some((block) => block.type === "tool_use")) {
		return null;
	}
	const text = last.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join(" ")
		.trim();
	return text || null;
}

export function createVetProbe(
	options: VetProbeOptions = {},
): (input: VetProbeInput) => Promise<VetProbeVerdict | null> {
	const reader = options.reader ?? createClineSessionFileReader();
	const sessionsPath = getClineSessionsPath(getClineDataDirPath(options.clineDataDir ?? null));
	const hungMin = options.hungMin ?? 15;
	return async (input) => {
		if (getAgentTurnEndSource(input.agentId) !== "cline-session-files") {
			return null;
		}
		const detail = await reader.readLatestSessionDetail(sessionsPath, input.worktreePath);
		const modelLoaded =
			input.providerId === LEMONADE_PROVIDER_ID && input.model && options.isLemonadeModelLoaded
				? await options.isLemonadeModelLoaded(input.model)
				: null;
		const loading = modelLoaded === false;
		if (detail) {
			const notice = readFinalClineErrorNotice(detail.messages);
			const providerError = detectFinalProviderError(detail.messages) ?? notice;
			if (providerError) {
				const text = providerError.slice(0, 300);
				if (isContextOverflowError(providerError)) {
					return { failure: { kind: "context_overflow", detail: text, harness: true }, hold: null };
				}
				if (isLocalProvider(input.providerId) && isProviderTimeoutError(providerError)) {
					return {
						failure: {
							kind: "provider_timeout",
							detail: `provider timeout ${loading ? `while ${input.providerId} loads ${input.model}` : `on ${input.providerId}`}: ${text}`,
							harness: true,
							occurrence: `${detail.snapshot.sessionId}:${detail.messages.length}`,
						},
						hold: null,
					};
				}
				return {
					failure: {
						kind: "provider_error",
						detail: text,
						// A rejected request (validation, a malformed tool call in the history) may be the model's doing.
						harness:
							isTransientProviderError(providerError) ||
							(notice !== null && !isPoisonedHistoryError(providerError)),
					},
					hold: null,
				};
			}
			const hung = loading
				? null
				: detectHungRequest(detail, {
						now: input.now,
						hungMin,
						hungFirstMin: hungMin * 2,
						slowFirstCall: isLocalProvider(input.providerId),
					});
			if (hung) {
				return {
					failure: { kind: "hung_request", detail: `a model request open for ${hung.idleMin} min`, harness: true },
					hold: null,
				};
			}
		}
		const stall = evaluateClineSilentStall({
			detail,
			kanbanProgressAt: input.kanbanProgressAt,
			runStartedAt: input.runStartedAt,
			firstReplyAllowanceMs: isLocalProvider(input.providerId) ? CLINE_FIRST_REPLY_LOAD_ALLOWANCE_MS : 0,
			modelLoading: loading,
			now: input.now,
		});
		if (!stall) {
			return { failure: null, hold: loading ? `${input.providerId} is still loading ${input.model}` : null };
		}
		if (stall.kind === "interrupted_tool" && options.findRunningTool) {
			const running = await options.findRunningTool(input.worktreePath, input.agentPid);
			if (running) {
				return { failure: null, hold: `the tool's command still runs (${running})` };
			}
		}
		// A model request in flight is the hung check's (above), which gives a slow first call twice as long.
		if (stall.kind === "untouched" && stall.status === "running") {
			return { failure: null, hold: "a model request in flight (the hung-request check's)" };
		}
		if (stall.idleMs >= input.stallMin * 60_000) {
			return {
				failure: {
					kind: stall.kind === "no_session" ? "no_session" : "silent_stall",
					detail: describeClineSilentStall(stall),
					...(stall.kind === "no_session" ? { harness: true } : {}),
				},
				hold: null,
			};
		}
		return { failure: null, hold: null };
	};
}
