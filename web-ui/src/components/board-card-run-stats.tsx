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
 * The right end of an In Progress, Review or Done card's agent row: its tokens in and out and its agent's running
 * time, "1.2M↓ 48k↑ · 12m" (Done: the final totals), kept on one line while the agent pill truncates. Nothing until
 * either is known. The time ticks only while the agent runs.
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
			className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[11px] leading-none text-text-tertiary"
			data-testid="board-card-run-stats"
		>
			{usage ? <BoardCardTokenUsage usage={usage} /> : null}
			{usage && time ? <span aria-hidden>·</span> : null}
			{time ? <BoardCardRunningTime time={time} /> : null}
		</div>
	);
}
