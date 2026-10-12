import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskTokenUsage } from "@/runtime/types";
import { useTaskTokenUsage } from "@/stores/task-token-usage-store";
import { formatTokenCount } from "@/utils/format-token-count";

function describeTokenUsage(usage: RuntimeTaskTokenUsage, total: number): string {
	const exact = (value: number) => value.toLocaleString("en-US");
	return [
		`${exact(total)} tokens over this card's agent sessions`,
		`input ${exact(usage.input)} · output ${exact(usage.output)}`,
		`cache read ${exact(usage.cacheRead)} · cache write ${exact(usage.cacheWrite)}`,
	].join("\n");
}

/**
 * A card's token count (all its agent sessions, cache included, from task-token-usage-store); nothing before any is
 * counted. Not on the board card yet: the card's centered second row takes it for In Progress and Review cards.
 */
export function BoardCardTokenUsage({ taskId }: { taskId: string }): React.ReactElement | null {
	const usage = useTaskTokenUsage(taskId);
	if (!usage) {
		return null;
	}
	const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return (
		<Tooltip side="bottom" content={<span className="whitespace-pre-line">{describeTokenUsage(usage, total)}</span>}>
			<span
				data-testid="board-card-token-usage"
				className="shrink-0 whitespace-nowrap font-mono text-[11px] leading-none text-text-tertiary"
			>
				{formatTokenCount(total)} tokens
			</span>
		</Tooltip>
	);
}
