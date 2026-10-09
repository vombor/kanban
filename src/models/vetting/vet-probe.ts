// The agent-specific failure detectors `kanban models vet` watches a run with, reusing recovery's readers: for agents
// whose turns Kanban reads from Cline's session files (getAgentTurnEndSource), the silent stall and `no_session`
// (evaluateClineSilentStall), a hung model request (detectHungRequest), and a turn that ended on a provider error or a
// context overflow (detectFinalProviderError). Other agents answer null here; the runner's own checks (no turn
// started, no progress, session failed, caps) still apply to them.

import type { RuntimeAgentId } from "../../core/api-contract";
import { detectFinalProviderError, detectHungRequest, isContextOverflowError } from "../../pipeline/recovery-detect";
import { getClineDataDirPath } from "../../state/kanban-home";
import { getAgentTurnEndSource } from "../../terminal/agent-session-adapters";
import {
	type ClineSessionDetailReader,
	createClineSessionFileReader,
	getClineSessionsPath,
} from "../../terminal/cline-session-files";
import { describeClineSilentStall, evaluateClineSilentStall } from "../../terminal/cline-turn-check";
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
	| "session_failed"
	| "time_cap"
	| "cost_cap"
	| "task";

export interface VetFailure {
	kind: VetFailureKind;
	detail: string;
}

export interface VetProbeInput {
	agentId: RuntimeAgentId;
	worktreePath: string;
	providerId: string | null;
	runStartedAt: number;
	/** Kanban's newest sign of progress (hooks, state changes, scratch repo writes). */
	kanbanProgressAt: number;
	stallMin: number;
	now: number;
}

export function createVetProbe(
	options: { clineDataDir?: string | null; hungMin?: number; reader?: ClineSessionDetailReader } = {},
): (input: VetProbeInput) => Promise<VetFailure | null> {
	const reader = options.reader ?? createClineSessionFileReader();
	const sessionsPath = getClineSessionsPath(getClineDataDirPath(options.clineDataDir ?? null));
	const hungMin = options.hungMin ?? 15;
	return async (input) => {
		if (getAgentTurnEndSource(input.agentId) !== "cline-session-files") {
			return null;
		}
		const detail = await reader.readLatestSessionDetail(sessionsPath, input.worktreePath);
		if (detail) {
			const providerError = detectFinalProviderError(detail.messages);
			if (providerError) {
				return {
					kind: isContextOverflowError(providerError) ? "context_overflow" : "provider_error",
					detail: providerError.slice(0, 300),
				};
			}
			const hung = detectHungRequest(detail, {
				now: input.now,
				hungMin,
				hungFirstMin: hungMin * 2,
				slowFirstCall: input.providerId === LEMONADE_PROVIDER_ID,
			});
			if (hung) {
				return { kind: "hung_request", detail: `a model request open for ${hung.idleMin} min` };
			}
		}
		const stall = evaluateClineSilentStall({
			detail,
			kanbanProgressAt: input.kanbanProgressAt,
			runStartedAt: input.runStartedAt,
			now: input.now,
		});
		if (stall && stall.idleMs >= input.stallMin * 60_000) {
			return {
				kind: stall.kind === "no_session" ? "no_session" : "silent_stall",
				detail: describeClineSilentStall(stall),
			};
		}
		return null;
	};
}
