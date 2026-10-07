// `kanban orchestrator wake <issue> [--when-card-done <id> | --when-model-up <model>]`: wakes the orchestrator now or
// once a condition holds. Requests are a file the CLI appends to (`data/<ws>/orchestrator-wake-requests.json`, under
// its lock) and the watchdog checks every tick, so there is no detached poller per request (plan §2.3). A due request
// becomes a wake item for that workspace and is removed.
//
//   --when-card-done <id>: the card is in Done or gone (a dev card bounces between Review and In Progress during
//                          rework, so leaving In Progress is not enough). A card id prefix matches.
//   --when-model-up <m>:   `kanban models probe` gets an answer from the model twice in a row, a minute or more apart
//                          (one good probe can be a flap: kimi-k3 07:37Z 10/06). Probed every 5 min.
//   --timeout-min N:       wake anyway after N min (default 240), saying the condition never held.
//
// Ported from archive/devteam-kit:bin/wake-when.mjs@6da71597 (--until-done, --model-up, modelUpTwice, timeout).
import { readFile } from "node:fs/promises";
import { z } from "zod";

import type { RuntimeBoardData } from "../../core/api-contract";
import { lockedFileSystem } from "../../fs/locked-file-system";

const MODEL_PROBE_EVERY_MS = 5 * 60_000;
const MODEL_CONFIRM_AFTER_MS = 60_000;
export const DEFAULT_WAKE_REQUEST_TIMEOUT_MIN = 240;

export const wakeRequestConditionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("card-done"), taskId: z.string().min(1) }),
	z.object({ kind: z.literal("model-up"), model: z.string().min(1), provider: z.string().min(1) }),
]);
export type WakeRequestCondition = z.infer<typeof wakeRequestConditionSchema>;

export const wakeRequestSchema = z.object({
	id: z.string(),
	createdAt: z.string(),
	issue: z.string(),
	when: wakeRequestConditionSchema.nullable(),
	timeoutMin: z.number().positive(),
	lastProbeAt: z.string().nullable().default(null),
	/** When the last probe answered (the second good probe, a minute later, makes the request due). */
	upSince: z.string().nullable().default(null),
});
export type WakeRequest = z.infer<typeof wakeRequestSchema>;

const wakeRequestFileSchema = z.object({ version: z.literal(1), requests: z.array(wakeRequestSchema) });

/** The pending requests (none when the file is missing or unreadable). A plain read: the watchdog writes only when it changes something. */
export async function readWakeRequests(path: string): Promise<WakeRequest[]> {
	try {
		const parsed = wakeRequestFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
		return parsed.success ? parsed.data.requests : [];
	} catch {
		return [];
	}
}

/** Read-modify-write of the request file under its lock (the CLI and the watchdog both write it). */
export async function updateWakeRequests<T>(
	path: string,
	update: (requests: WakeRequest[]) => { requests: WakeRequest[]; value: T },
): Promise<T> {
	return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const result = update(await readWakeRequests(path));
		await lockedFileSystem.writeJsonFileAtomic(path, { version: 1, requests: result.requests }, { lock: null });
		return result.value;
	});
}

export async function addWakeRequest(
	path: string,
	input: { issue: string; when: WakeRequestCondition | null; timeoutMin?: number; now?: Date },
): Promise<WakeRequest> {
	const now = input.now ?? new Date();
	const request: WakeRequest = {
		id: `${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
		createdAt: now.toISOString(),
		issue: input.issue.replace(/\s+/gu, " ").trim(),
		when: input.when,
		timeoutMin: input.timeoutMin ?? DEFAULT_WAKE_REQUEST_TIMEOUT_MIN,
		lastProbeAt: null,
		upSince: null,
	};
	return await updateWakeRequests(path, (requests) => ({ requests: [...requests, request], value: request }));
}

export interface WakeRequestCheck {
	/** Wake items that are due now (each request once). */
	items: string[];
	/** The requests that stay. */
	remaining: WakeRequest[];
	log: string[];
}

function cardColumn(board: RuntimeBoardData, taskId: string): string {
	return board.columns.find((column) => column.cards.some((card) => card.id.startsWith(taskId)))?.id ?? "gone";
}

/** Checks each request; `probe` runs only for model-up requests whose probe is due. */
export async function checkWakeRequests(input: {
	requests: readonly WakeRequest[];
	board: RuntimeBoardData;
	now: number;
	probe: (provider: string, model: string) => Promise<boolean>;
}): Promise<WakeRequestCheck> {
	const items: string[] = [];
	const remaining: WakeRequest[] = [];
	const log: string[] = [];
	for (const request of input.requests) {
		const timedOut = input.now - Date.parse(request.createdAt) > request.timeoutMin * 60_000;
		const when = request.when;
		if (!when) {
			items.push(`- ${request.issue}`);
			continue;
		}
		if (when.kind === "card-done") {
			const column = cardColumn(input.board, when.taskId);
			const done = column === "trash" || column === "gone";
			if (done || timedOut) {
				items.push(
					done
						? `- ${request.issue}`
						: `- ${request.issue} (wake request timed out after ${request.timeoutMin} min: card ${when.taskId} ${column})`,
				);
				log.push(`wake request ${request.id}: card ${when.taskId} ${column}${done ? "" : ", timed out"}`);
				continue;
			}
			remaining.push(request);
			continue;
		}
		const next = { ...request };
		const lastProbe = request.lastProbeAt ? Date.parse(request.lastProbeAt) : 0;
		const upSince = request.upSince ? Date.parse(request.upSince) : null;
		const probeDue =
			upSince !== null
				? input.now - upSince >= MODEL_CONFIRM_AFTER_MS
				: input.now - lastProbe >= MODEL_PROBE_EVERY_MS;
		if (probeDue) {
			const up = await input.probe(when.provider, when.model).catch(() => false);
			next.lastProbeAt = new Date(input.now).toISOString();
			if (up && upSince !== null) {
				items.push(`- ${request.issue}`);
				log.push(`wake request ${request.id}: ${when.model} answers (twice)`);
				continue;
			}
			next.upSince = up ? new Date(input.now).toISOString() : null;
		}
		if (timedOut) {
			items.push(
				`- ${request.issue} (wake request timed out after ${request.timeoutMin} min: ${when.model} still down)`,
			);
			log.push(`wake request ${request.id}: ${when.model} still down, timed out`);
			continue;
		}
		remaining.push(next);
	}
	return { items, remaining, log };
}
