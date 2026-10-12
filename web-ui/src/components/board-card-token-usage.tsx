import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskTokenUsage } from "@/runtime/types";
import { formatTokenCount } from "@/utils/format-token-count";

export function getTokenUsageTotal(usage: RuntimeTaskTokenUsage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function describeTokenUsage(usage: RuntimeTaskTokenUsage, total: number): string {
	const exact = (value: number) => value.toLocaleString("en-US");
	return [
		`${exact(total)} tokens over this card's agent sessions`,
		`input ${exact(usage.input)} · output ${exact(usage.output)}`,
		`cache read ${exact(usage.cacheRead)} · cache write ${exact(usage.cacheWrite)}`,
	].join("\n");
}

/** A card's token count (all its agent sessions, cache included), with the split in its tooltip. No cost. */
export function BoardCardTokenUsage({ usage }: { usage: RuntimeTaskTokenUsage }): React.ReactElement {
	const total = getTokenUsageTotal(usage);
	return (
		<Tooltip side="bottom" content={<span className="whitespace-pre-line">{describeTokenUsage(usage, total)}</span>}>
			<span data-testid="board-card-token-usage" className="whitespace-nowrap">
				{formatTokenCount(total)} tok
			</span>
		</Tooltip>
	);
}
