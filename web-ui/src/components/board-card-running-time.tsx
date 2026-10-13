import { formatRunningDuration, readTaskRunningTime, type TaskRunningTime } from "@runtime-task-running-time";
import { useState } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { formatLocalTime, type LocalTimeFormatOptions } from "@/utils/format-local-time";
import { useInterval } from "@/utils/react-use";

/** How often a running card's time is redrawn. */
export const RUNNING_TIME_TICK_MS = 1_000;

export function describeRunningTime(time: TaskRunningTime, options?: LocalTimeFormatOptions): string {
	const runs =
		time.runCount > 0 ? ` over ${time.runCount} ${time.runCount === 1 ? "run" : "runs"}` : " (runs not counted)";
	const lines = [`Agent running time ${formatRunningDuration(time.totalMs)}${runs}`];
	if (time.firstRunStartedAt !== null) {
		lines.push(`First run started ${formatLocalTime(time.firstRunStartedAt, options)}`);
	}
	lines.push(time.runningSince !== null ? "Running now" : "Review, idle and waiting time not counted");
	return lines.join("\n");
}

/** How long the card's agent has worked (src/core/task-running-time.ts), with what it counts in its tooltip. */
export function BoardCardRunningTime({
	sessionSummary,
}: {
	sessionSummary: RuntimeTaskSessionSummary | undefined;
}): React.ReactElement | null {
	const [, setTick] = useState(0);
	useInterval(() => setTick((tick) => tick + 1), sessionSummary?.state === "running" ? RUNNING_TIME_TICK_MS : null);
	const time = readTaskRunningTime(sessionSummary, Date.now());
	if (!time) {
		return null;
	}
	return (
		<Tooltip side="bottom" content={<span className="whitespace-pre-line">{describeRunningTime(time)}</span>}>
			<span
				data-testid="board-card-running-time"
				className="ml-auto shrink-0 whitespace-nowrap font-mono text-[11px] leading-none text-text-tertiary"
			>
				{formatRunningDuration(time.totalMs)}
			</span>
		</Tooltip>
	);
}
