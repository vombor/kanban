// Absolute, machine-wide quota deadlines. Hydrated before QA starts, persisted before replacing a limited QA card.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getProviderUsageHoldsPath } from "../state/kanban-home";

const stateSchema = z
	.object({ version: z.literal(1), holds: z.record(z.string(), z.number().finite().nonnegative()) })
	.strict();
export interface ProviderUsageHolds {
	ready: () => Promise<void>;
	until: (provider: string, now: number) => number | null;
	record: (provider: string, until: number) => Promise<number>;
}

export function createProviderUsageHolds(
	options: {
		path?: string;
		/** One-time compatibility import from previously persisted QA error records. */
		readLegacy?: () => Promise<Record<string, number>>;
	} = {},
): ProviderUsageHolds {
	const path = options.path ?? getProviderUsageHoldsPath();
	let holds: Record<string, number> = {};
	const deadlineOf = (values: Record<string, number>, provider: string) =>
		Object.hasOwn(values, provider) ? (values[provider] ?? 0) : 0;
	let initialization: Promise<void> | null = null;
	const read = async () => {
		try {
			return stateSchema.parse(JSON.parse(await readFile(path, "utf8"))).holds;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
			// Never overwrite a damaged hold file and start quota-limited sessions as if there were no holds.
			throw new Error(`Could not read provider quota holds at ${path}`);
		}
	};
	const ready = async () => {
		if (!initialization) {
			initialization = (async () => {
				const legacy = (await options.readLegacy?.()) ?? {};
				await lockedFileSystem.withLock({ path }, async () => {
					holds = await read();
					let changed = false;
					for (const [provider, until] of Object.entries(legacy)) {
						if (!Number.isFinite(until) || until < 0) continue;
						if (until > deadlineOf(holds, provider)) {
							holds = { ...holds, [provider]: until };
							changed = true;
						}
					}
					if (changed) await lockedFileSystem.writeJsonFileAtomic(path, { version: 1, holds }, { lock: null });
				});
			})().catch((error) => {
				initialization = null;
				throw error;
			});
		}
		await initialization;
	};
	return {
		ready,
		until: (provider, now) => (deadlineOf(holds, provider) > now ? deadlineOf(holds, provider) : null),
		record: async (provider, until) => {
			if (!Number.isFinite(until) || until < 0) throw new Error("Invalid provider quota deadline");
			await ready();
			return await lockedFileSystem.withLock({ path }, async () => {
				const stored = await read();
				const deadline = Math.max(until, deadlineOf(stored, provider), deadlineOf(holds, provider));
				holds = { ...stored, [provider]: deadline };
				await lockedFileSystem.writeJsonFileAtomic(path, { version: 1, holds }, { lock: null });
				return deadline;
			});
		},
	};
}
