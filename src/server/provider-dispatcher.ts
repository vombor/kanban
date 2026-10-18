// One instance-wide admission point. Pending starts are private durable per-project intents, not execution approval.
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";
import type { RuntimeTaskSessionStartResponse } from "../core/api-contract";
import {
	type providerStartIntentSchema as intentSchema,
	providerStartQueueSchema as queueSchema,
} from "../core/provider-start-intent";
import { renameDurably, writeFileSynced } from "../fs/durable-file";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getKanbanRunPath, getKanbanWorkspaceDataPath } from "../state/kanban-home";

export type ProviderStartIntent = z.infer<typeof intentSchema> & { workspaceId: string };
export interface ProviderActivity {
	key: string;
	resources: string[];
}
export interface ProviderAdmission {
	resources: string[];
	until: number | null;
	provider: string | null;
}
export interface ProviderDispatcherDependencies {
	workspaceIds: () => Promise<string[]>;
	limits: () => Promise<Record<string, number>>;
	activity: () => Promise<ProviderActivity[]>;
	admission: (intent: ProviderStartIntent) => Promise<ProviderAdmission>;
	valid: (intent: ProviderStartIntent) => Promise<boolean>;
	execute: (intent: ProviderStartIntent, signal: AbortSignal) => Promise<RuntimeTaskSessionStartResponse>;
	queued: (intent: ProviderStartIntent, admission: ProviderAdmission) => Promise<void>;
	finished: (intent: ProviderStartIntent, result: RuntimeTaskSessionStartResponse | null) => Promise<void>;
	queuePath?: (workspaceId: string) => string;
	lockPath?: string;
	now?: () => number;
	log: (message: string) => void;
}

export function createProviderDispatcher(deps: ProviderDispatcherDependencies) {
	const now = deps.now ?? Date.now;
	const queuePath = deps.queuePath ?? ((id) => join(getKanbanWorkspaceDataPath(id), "provider-starts.json"));
	const lockPath = deps.lockPath ?? join(getKanbanRunPath(), "provider-dispatch");
	const reserved = new Map<string, ProviderActivity>();
	const controllers = new Map<string, AbortController>();
	let timer: ReturnType<typeof setInterval> | null = null;
	let closed = false;
	const keyOf = (intent: Pick<ProviderStartIntent, "workspaceId" | "taskId">) =>
		`${intent.workspaceId}\0${intent.taskId}`;
	const read = async (id: string) => {
		try {
			return queueSchema.parse(JSON.parse(await readFile(queuePath(id), "utf8"))).pending;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
			throw new Error(
				"Provider start queue is unreadable; pending intents are kept and no new start is authorized.",
			);
		}
	};
	const write = async (id: string, pending: z.infer<typeof intentSchema>[]) => {
		const path = queuePath(id);
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.${randomUUID()}.tmp`;
		await writeFileSynced(tmp, JSON.stringify({ version: 1, pending }, null, 2), { mode: 0o600 });
		await renameDurably(tmp, path);
	};
	const all = async () => {
		const result: ProviderStartIntent[] = [];
		for (const id of await deps.workspaceIds())
			for (const intent of await read(id)) result.push({ ...intent, workspaceId: id });
		return result.sort((a, b) => a.at - b.at);
	};
	const resourcesOf = (resources: string[], limits: Record<string, number>) =>
		resources.includes("provider:*")
			? [
					...new Set([
						...resources.filter((resource) => resource !== "provider:*"),
						...Object.keys(limits).filter((resource) => resource.startsWith("provider:")),
					]),
				]
			: resources;
	const canReserve = async (intent: ProviderStartIntent, earlier: ProviderStartIntent[]) => {
		if (controllers.has(keyOf(intent))) return null;
		const limits = await deps.limits();
		const admission = await deps.admission(intent);
		const resources = resourcesOf(admission.resources, limits);
		if (closed || (admission.until !== null && admission.until > now())) return null;
		for (const old of earlier) {
			if (keyOf(old) === keyOf(intent) || controllers.has(keyOf(old))) continue;
			const oldAdmission = await deps.admission(old);
			if (oldAdmission.until !== null && oldAdmission.until > now()) continue;
			const previous = resourcesOf(oldAdmission.resources, limits);
			if (previous.some((resource) => resources.includes(resource))) return null;
		}
		const active = [...(await deps.activity()), ...reserved.values()];
		for (const resource of resources) {
			const cap = Object.hasOwn(limits, resource) ? limits[resource] : undefined;
			if (cap === undefined) continue;
			const holders = new Set(
				active.filter((item) => resourcesOf(item.resources, limits).includes(resource)).map((item) => item.key),
			);
			if (!holders.has(keyOf(intent)) && holders.size >= cap) return null;
		}
		reserved.set(keyOf(intent), { key: keyOf(intent), resources: admission.resources });
		const controller = new AbortController();
		controllers.set(keyOf(intent), controller);
		return controller;
	};
	const remove = async (intent: ProviderStartIntent) =>
		write(
			intent.workspaceId,
			(await read(intent.workspaceId)).filter((item) =>
				intent.id ? item.id !== intent.id : item.taskId !== intent.taskId || item.at !== intent.at,
			),
		);
	const execute = async (intent: ProviderStartIntent, controller: AbortController) => {
		let result: RuntimeTaskSessionStartResponse | null = null;
		try {
			if (!closed && !controller.signal.aborted && (await deps.valid(intent)))
				result = await deps.execute(intent, controller.signal);
			if (!closed) await deps.finished(intent, result);
			return (
				result ?? {
					ok: false,
					summary: null,
					error: "Queued start was cancelled or the card changed; no new turn was authorized.",
				}
			);
		} finally {
			await lockedFileSystem.withLock({ path: lockPath }, async () => {
				if (!closed) await remove(intent);
				if (controllers.get(keyOf(intent)) === controller) {
					reserved.delete(keyOf(intent));
					controllers.delete(keyOf(intent));
				}
			});
		}
	};
	const submit = async (intent: ProviderStartIntent): Promise<RuntimeTaskSessionStartResponse> => {
		intent = { ...intent, id: intent.id ?? randomUUID() };
		const controller = await lockedFileSystem.withLock({ path: lockPath }, async () => {
			const pending = await all();
			const existing = pending.find((item) => keyOf(item) === keyOf(intent));
			if (existing) {
				intent = existing;
				return null;
			}
			if (!(await deps.valid(intent)))
				throw new Error("The card changed, is Done or is held; no new turn is authorized.");
			const current = await read(intent.workspaceId);
			if (current.length >= 1000)
				throw new Error("This project's provider start queue is full; existing intents are kept.");
			const { workspaceId: _scope, ...stored } = intent;
			await write(intent.workspaceId, [...current, stored]);
			const admitted = await canReserve(intent, pending);
			return admitted;
		});
		if (!controller && !controllers.has(keyOf(intent))) await deps.queued(intent, await deps.admission(intent));
		return controller
			? await execute(intent, controller)
			: {
					ok: true,
					queued: true,
					summary: null,
					message:
						"Start queued behind shared provider capacity/quota; duplicate requests do not create another turn.",
				};
	};
	const flush = async () => {
		if (closed) return;
		const selected: Array<[ProviderStartIntent, AbortController]> = [];
		const cancelled: ProviderStartIntent[] = [];
		await lockedFileSystem.withLock({ path: lockPath }, async () => {
			const pending = await all();
			for (let index = 0; index < pending.length; index++) {
				const intent = pending[index];
				if (!intent || controllers.has(keyOf(intent))) continue;
				if (!(await deps.valid(intent))) {
					await remove(intent);
					cancelled.push(intent);
					continue;
				}
				const controller = await canReserve(intent, pending.slice(0, index));
				if (controller) selected.push([intent, controller]);
			}
		});
		await Promise.all(cancelled.map((intent) => deps.finished(intent, null)));
		await Promise.allSettled(selected.map(([intent, controller]) => execute(intent, controller)));
	};
	return {
		submit,
		flush,
		pending: all,
		activity: async () => [...(await deps.activity()), ...reserved.values()],
		limits: deps.limits,
		cancel: async (workspaceId: string, taskId: string) => {
			const found = await lockedFileSystem.withLock({ path: lockPath }, async () => {
				controllers.get(`${workspaceId}\0${taskId}`)?.abort();
				const intents = await read(workspaceId);
				const found = intents.find((intent) => intent.taskId === taskId);
				if (found)
					await write(
						workspaceId,
						intents.filter((intent) => intent.taskId !== taskId),
					);
				return found;
			});
			if (found) await deps.finished({ ...found, workspaceId }, null);
		},
		reserveInput: async (workspaceId: string, taskId: string, admission: ProviderAdmission) =>
			lockedFileSystem.withLock({ path: lockPath }, async () => {
				const key = `${workspaceId}\0${taskId}`;
				const limits = await deps.limits();
				if (admission.until !== null && admission.until > now()) return false;
				const active = [...(await deps.activity()), ...reserved.values()];
				for (const resource of resourcesOf(admission.resources, limits)) {
					const cap = Object.hasOwn(limits, resource) ? limits[resource] : undefined;
					if (
						cap !== undefined &&
						new Set(
							active
								.filter((item) => item.key !== key && resourcesOf(item.resources, limits).includes(resource))
								.map((item) => item.key),
						).size >= cap
					)
						return false;
				}
				reserved.set(key, { key, resources: admission.resources });
				return true;
			}),
		releaseInput: (workspaceId: string, taskId: string) => {
			if (!controllers.has(`${workspaceId}\0${taskId}`)) reserved.delete(`${workspaceId}\0${taskId}`);
		},
		start: (intervalMs = 1000) => {
			closed = false;
			timer ??= setInterval(() => {
				void flush().catch(() =>
					deps.log("Provider dispatcher could not reconcile private queues; no failed intent was discarded."),
				);
			}, intervalMs);
			timer.unref();
		},
		close: () => {
			closed = true;
			if (timer) clearInterval(timer);
			timer = null;
			for (const controller of controllers.values()) controller.abort();
		},
	};
}
export type ProviderDispatcher = ReturnType<typeof createProviderDispatcher>;
