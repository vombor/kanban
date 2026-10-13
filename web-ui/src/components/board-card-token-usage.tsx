import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskTokenUsage } from "@/runtime/types";
import { formatTokenCount } from "@/utils/format-token-count";

export interface TokenUsageInOut {
	/** Everything the model was sent: uncached input + cache read + cache write. */
	in: number;
	out: number;
}

/**
 * A card's tokens in and out. "In" counts the cache: a Claude card re-reads millions of cached tokens while its
 * uncached input stays a few thousand, so input alone would hide what the model was sent.
 */
export function getTokenUsageInOut(usage: RuntimeTaskTokenUsage): TokenUsageInOut {
	return { in: usage.input + usage.cacheRead + usage.cacheWrite, out: usage.output };
}

export function describeTokenUsage(usage: RuntimeTaskTokenUsage, totals: TokenUsageInOut): string {
	const exact = (value: number) => value.toLocaleString("en-US");
	return [
		`${exact(totals.in)} tokens in · ${exact(totals.out)} tokens out over this card's agent sessions`,
		`In includes the cache: input ${exact(usage.input)} · cache read ${exact(usage.cacheRead)} · cache write ${exact(usage.cacheWrite)}`,
		`Out: output ${exact(usage.output)}`,
	].join("\n");
}

/** A card's tokens in and out, "1.2M↓ 48k↑" (all its agent sessions), with the full split in its tooltip. No cost. */
export function BoardCardTokenUsage({
	usage,
}: {
	usage: RuntimeTaskTokenUsage | null | undefined;
}): React.ReactElement | null {
	if (!usage || usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) {
		return null;
	}
	const totals = getTokenUsageInOut(usage);
	const tokensIn = formatTokenCount(totals.in);
	const tokensOut = formatTokenCount(totals.out);
	return (
		<Tooltip side="bottom" content={<span className="whitespace-pre-line">{describeTokenUsage(usage, totals)}</span>}>
			<span
				data-testid="board-card-token-usage"
				role="img"
				aria-label={`${tokensIn} tokens in, ${tokensOut} tokens out`}
				className="ml-auto shrink-0 whitespace-nowrap font-mono text-[11px] leading-none text-text-tertiary"
			>
				<span data-testid="board-card-tokens-in">{tokensIn}↓</span>{" "}
				<span data-testid="board-card-tokens-out">{tokensOut}↑</span>
			</span>
		</Tooltip>
	);
}
