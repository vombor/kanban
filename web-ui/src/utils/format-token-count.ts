const TOKEN_COUNT_UNITS = ["", "k", "M", "B"] as const;

function roundForLabel(value: number): number {
	return value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
}

/** A token count for a narrow label: 950, 12.3k, 4.1M (one decimal below 100 of a unit, none above). */
export function formatTokenCount(tokens: number): string {
	const value = Math.max(0, Math.round(tokens));
	let scaled = value;
	let unit = 0;
	while (unit < TOKEN_COUNT_UNITS.length - 1 && roundForLabel(scaled) >= 1000) {
		scaled /= 1000;
		unit += 1;
	}
	return unit === 0 ? String(value) : `${roundForLabel(scaled)}${TOKEN_COUNT_UNITS[unit]}`;
}
