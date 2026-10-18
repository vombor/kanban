import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { renameDurably, writeFileSynced } from "../fs/durable-file";
import { lockedFileSystem } from "../fs/locked-file-system";
import { readKnowledgeFile } from "../knowledge/content-store";
import { getEfficiencyStatePath } from "../state/kanban-home";
import { type EfficiencyCategory, efficiencyCategorySchema, efficiencySpanSchema } from "../trpc/efficiency-contract";

const stateSchema = z
	.object({
		version: z.literal(1),
		spans: z.array(efficiencySpanSchema).max(10000),
		agentSamples: z
			.array(
				z
					.object({
						taskId: z.string().max(160),
						start: z.number().nonnegative(),
						end: z.number().nonnegative(),
						ms: z.number().nonnegative(),
					})
					.strict(),
			)
			.max(10000)
			.default([]),
		last: z
			.object({
				serverId: z.string(),
				at: z.number().nonnegative(),
				labels: z.record(z.string(), z.array(efficiencyCategorySchema)),
				counters: z.record(z.string(), z.number().nonnegative()).default({}),
			})
			.nullable(),
		gaps: z.number().int().nonnegative(),
	})
	.strict();
export type EfficiencyTimingState = z.infer<typeof stateSchema>;
export function createEfficiencyTimingStore(homePath?: string) {
	const path = (workspaceId: string) => getEfficiencyStatePath(workspaceId, homePath);
	const read = async (workspaceId: string): Promise<EfficiencyTimingState> => {
		let text: string;
		try {
			text = await readKnowledgeFile(path(workspaceId), 8388608);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
				return { version: 1, spans: [], agentSamples: [], last: null, gaps: 0 };
			throw new Error("Efficiency history unavailable; retained observations were not reset.");
		}
		const state = stateSchema.parse(JSON.parse(text));
		if (
			state.spans.some((span) => span.end < span.start) ||
			state.agentSamples.some((sample) => sample.end < sample.start || sample.ms > sample.end - sample.start + 1000)
		)
			throw new Error("Invalid timing interval");
		return state;
	};
	return {
		read,
		sample: async (
			workspaceId: string,
			input: {
				serverId: string;
				at: number;
				labels: Record<string, EfficiencyCategory[]>;
				counters: Record<string, number>;
			},
		) =>
			lockedFileSystem.withLock({ path: path(workspaceId) }, async () => {
				const state = await read(workspaceId),
					previous = state.last;
				if (previous && previous.serverId === input.serverId && input.at <= previous.at) return;
				if (previous && previous.serverId === input.serverId && input.at - previous.at <= 30000) {
					const tails = new Map(state.spans.map((span) => [JSON.stringify([span.taskId, span.category]), span]));
					for (const [taskId, categories] of Object.entries(input.labels))
						for (const category of new Set(categories)) {
							if (!previous.labels[taskId]?.includes(category)) continue;
							const key = JSON.stringify([taskId, category]),
								last = tails.get(key);
							if (last?.end === previous.at) last.end = input.at;
							else {
								const span = { taskId, category, start: previous.at, end: input.at };
								state.spans.push(span);
								tails.set(key, span);
							}
						}
					const activeTails = new Map(state.agentSamples.map((sample) => [sample.taskId, sample]));
					for (const [taskId, total] of Object.entries(input.counters)) {
						const prior = previous.counters[taskId];
						if (prior === undefined) continue;
						const delta = total - prior;
						if (delta < 0 || delta > input.at - previous.at + 1000) {
							state.gaps++;
							continue;
						}
						if (delta > 0) {
							const tail = activeTails.get(taskId);
							if (tail?.end === previous.at && tail.ms + delta <= input.at - tail.start + 1000) {
								tail.end = input.at;
								tail.ms += delta;
							} else state.agentSamples.push({ taskId, start: previous.at, end: input.at, ms: delta });
						}
					}
				} else if (previous) state.gaps++;
				state.last = { ...input };
				const text = JSON.stringify(stateSchema.parse(state));
				if (Buffer.byteLength(text) > 8388608 || Object.keys(input.labels).length > 5000)
					throw new Error("Efficiency retention ceiling reached; no history was evicted.");
				await mkdir(dirname(path(workspaceId)), { recursive: true, mode: 0o700 });
				const tmp = `${path(workspaceId)}.${randomUUID()}.tmp`;
				try {
					await writeFileSynced(tmp, text, { mode: 0o600, flag: "wx" });
					await renameDurably(tmp, path(workspaceId));
				} finally {
					await rm(tmp, { force: true });
				}
			}),
	};
}
