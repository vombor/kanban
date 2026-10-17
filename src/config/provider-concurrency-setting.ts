import { readFile } from "node:fs/promises";
import { z } from "zod";
import { type ProviderConcurrencySettings, providerConcurrencySchema } from "../core/provider-concurrency";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getKanbanGlobalConfigPath } from "../state/kanban-home";

const objectSchema = z.record(z.string(), z.unknown());
async function readCriticalConfig(path: string): Promise<Record<string, unknown>> {
	try {
		return objectSchema.parse(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
		throw new Error("Provider pacing configuration is unreadable; no new launch or overwrite is authorized.");
	}
}

/** Critical dispatch configuration is fail-closed rather than silently replaced with unlimited defaults. */
export async function readProviderConcurrency(
	path = getKanbanGlobalConfigPath(),
): Promise<ProviderConcurrencySettings> {
	const raw = await readCriticalConfig(path);
	const result = providerConcurrencySchema.safeParse(
		raw.providerConcurrency === undefined ? {} : raw.providerConcurrency,
	);
	if (!result.success)
		throw new Error(
			"Provider concurrency configuration is invalid; use positive integer limits (1–1024) and provider identifiers.",
		);
	return result.data;
}

export async function readProjectProviderConcurrency(
	workspaceIds: readonly string[],
	path = getKanbanGlobalConfigPath(),
): Promise<ProviderConcurrencySettings[]> {
	const raw = await readCriticalConfig(path);
	const workspaces = objectSchema.safeParse(raw.workspaces === undefined ? {} : raw.workspaces);
	if (!workspaces.success)
		throw new Error("Project provider pacing configuration is invalid; no new launch is authorized");
	return workspaceIds.map((id) => {
		const entry = workspaces.data[id];
		if (entry !== undefined && !objectSchema.safeParse(entry).success)
			throw new Error("A project's pacing configuration is invalid; no new launch is authorized");
		const value =
			entry && typeof entry === "object" && "providerConcurrency" in entry ? entry.providerConcurrency : {};
		const parsed = providerConcurrencySchema.safeParse(value);
		if (!parsed.success) throw new Error("A project's provider pacing is invalid; no new model start is authorized");
		return parsed.data;
	});
}

export async function setProviderConcurrency(
	provider: string,
	limit: number | null,
	path = getKanbanGlobalConfigPath(),
) {
	providerConcurrencySchema.parse({ [provider]: limit ?? 1 });
	return await lockedFileSystem.withLock({ path }, async () => {
		const raw = await readCriticalConfig(path);
		const previous = providerConcurrencySchema.parse(
			raw.providerConcurrency === undefined ? {} : raw.providerConcurrency,
		);
		const next = { ...previous };
		if (limit === null) delete next[provider];
		else next[provider] = limit;
		await lockedFileSystem.writeJsonFileAtomic(path, { ...raw, providerConcurrency: next }, { lock: null });
		return {
			key: `providerConcurrency.${provider}`,
			from: previous[provider] ?? null,
			to: limit,
			configPath: path,
			next: "Shared provider dispatch reads this immediately; existing running turns are not interrupted. Project limits may be stricter.",
		};
	});
}
