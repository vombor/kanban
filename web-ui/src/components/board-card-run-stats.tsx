import { readTaskRunningTime } from "@runtime-task-running-time";
import { useState } from "react";

import { BoardCardRunningTime } from "@/components/board-card-running-time";
import { BoardCardTokenUsage } from "@/components/board-card-token-usage";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useTaskTokenUsage } from "@/stores/task-token-usage-store";
import { useInterval } from "@/utils/react-use";

/** How often a running card's time is redrawn. */
export const RUNNING_TIME_TICK_MS = 1_000;

/**
 * The centered second row of an In Progress, Review or Done card: its token count and its agent's running time,
 * "48k tok · 12m" (Done: the final totals). Nothing until either is known. The time ticks only while the agent runs.
 */
export function BoardCardRunStats({
	taskId,
	sessionSummary,
}: {
	taskId: string;
	sessionSummary: RuntimeTaskSessionSummary | undefined;
}): React.ReactElement | null {
	const usage = useTaskTokenUsage(taskId);
	// The live span is read at render; the tick only redraws while the agent runs.
	const [, setTick] = useState(0);
	useInterval(() => setTick((tick) => tick + 1), sessionSummary?.state === "running" ? RUNNING_TIME_TICK_MS : null);
	const time = readTaskRunningTime(sessionSummary, Date.now());
	if (!usage && !time) {
		return null;
	}
	return (
		<div
			className="mt-1 flex items-center justify-center gap-1 font-mono text-[11px] leading-none text-text-tertiary"
			data-testid="board-card-second-row"
		>
			{usage ? <BoardCardTokenUsage usage={usage} /> : null}
			{usage && time ? <span aria-hidden>·</span> : null}
			{time ? <BoardCardRunningTime time={time} /> : null}
		</div>
	);
}
