import { z } from "zod";

export const providerConcurrencySchema = z.record(
	z.string().regex(/^(?:agent:)?[a-z0-9][a-z0-9-]{0,63}$/u),
	z.number().int().min(1).max(1024),
);
export type ProviderConcurrencySettings = z.infer<typeof providerConcurrencySchema>;

/** Restrictive project pacing can only reduce a shared cap, never override another project's or the user's limit. */
export function mergeProviderConcurrency(values: readonly ProviderConcurrencySettings[]): ProviderConcurrencySettings {
	const limits = new Map<string, number>();
	for (const value of values)
		for (const [provider, limit] of Object.entries(value))
			limits.set(provider, Math.min(limit, limits.get(provider) ?? Infinity));
	return Object.fromEntries(limits);
}
