import { formatRunningDuration, type TaskRunningTime } from "@runtime-task-running-time";

import { Tooltip } from "@/components/ui/tooltip";
import { formatLocalTime, type LocalTimeFormatOptions } from "@/utils/format-local-time";

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
export function BoardCardRunningTime({ time }: { time: TaskRunningTime }): React.ReactElement {
	return (
		<Tooltip side="bottom" content={<span className="whitespace-pre-line">{describeRunningTime(time)}</span>}>
			<span data-testid="board-card-running-time" className="whitespace-nowrap">
				{formatRunningDuration(time.totalMs)}
			</span>
		</Tooltip>
	);
}
