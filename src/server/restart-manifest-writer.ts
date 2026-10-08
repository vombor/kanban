// The server keeps each workspace's restart manifest (data/<ws>/restart-manifest.json) up to date itself, so a hard
// crash, OOM kill, power loss or reboot without `kanban restart prepare` still leaves restart recovery a manifest at
// most a few minutes old instead of a guess from summaries alone.
//
// Written every `intervalMs` (default 5 min), `debounceMs` after an In Progress/Review change (a board change, or a
// session changing state), and once at a clean shutdown before the sessions are stopped (`source` "periodic" /
// "shutdown"; src/pipeline/restart-recovery.ts says how recovery reads them). Atomic (writeRestartManifest).
//
// No WIP tags here, and none carried over from a `kanban restart prepare` manifest: a tag commits the whole worktree
// (untracked files included) through a temporary index and adds a new tag per run, which every few minutes per card
// means tag churn and git work beside a busy agent, and an old tag no longer holds the work done since. A crash leaves
// the worktree as it was, so recovery's resume tags it fresh (it never reuses a server-written manifest's tags). Tags
// stay `kanban restart prepare`'s, before a planned restart.
//
// Two manifests are held back from periodic writes. The previous server's, while this start may still need it: until
// restart recovery has planned with it (`plannedAt`, markRestartManifestPlanned) or removed it, the file no longer is
// the one read at this server's start, or `handoverMs` have passed (nothing else will use it). And a
// `kanban restart prepare` manifest of this server younger than `prepareHoldMs` (a planned restart is coming, and its
// tags and listing are the ones to use; the shutdown write keeps it too). A shutdown write never waits for the
// handover: this server's own state is then the one the next start needs.
//
// Read, hold checks and write run under the manifest's file lock, the one `kanban restart prepare` and recovery take.
import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	isManifestForStart,
	listRestartManifestCandidates,
	type RestartManifest,
	type RestartManifestCard,
	readRestartManifest,
	withRestartManifestLock,
	writeRestartManifest,
} from "../pipeline/restart-recovery";
import type { RuntimeWorkspaceActivity } from "./runtime-state-hub";

export const DEFAULT_RESTART_MANIFEST_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_RESTART_MANIFEST_DEBOUNCE_MS = 15_000;
export const DEFAULT_RESTART_MANIFEST_HANDOVER_MS = 10 * 60_000;
export const DEFAULT_PREPARE_MANIFEST_HOLD_MS = 30 * 60_000;

export interface RestartManifestWorkspaceView {
	board: RuntimeBoardData;
	/** The newest summary per task: the session manager's live ones, else sessions.json. */
	sessions: Record<string, Pick<RuntimeTaskSessionSummary, "state" | "modelId">>;
}

export interface CreateRestartManifestWriterDependencies {
	listWorkspaceIds: () => string[];
	/** The workspace's board and sessions, or null when it is no longer registered. */
	loadWorkspace: (workspaceId: string) => Promise<RestartManifestWorkspaceView | null>;
	serverStartedAt: number;
	/** The start record of the server before this one (isManifestForStart), or null. */
	previousServerStartedAt: number | null;
	readManifest?: (workspaceId: string) => Promise<RestartManifest | null>;
	/** Called inside `withManifestLock`, so it must not take the manifest's lock again. */
	writeManifest?: (workspaceId: string, manifest: RestartManifest) => Promise<unknown>;
	withManifestLock?: <T>(workspaceId: string, operation: () => Promise<T>) => Promise<T>;
	now?: () => number;
	intervalMs?: number;
	debounceMs?: number;
	handoverMs?: number;
	prepareHoldMs?: number;
	warn?: (message: string) => void;
}

export interface RestartManifestWriter {
	/** Starts the periodic writes and queues a first write of every workspace. */
	start: () => void;
	/** A board broadcast or a session summary (runtime-state-hub `onWorkspaceActivity`): cheap unless a state changed. */
	notifyActivity: (activity: RuntimeWorkspaceActivity) => void;
	forgetWorkspace: (workspaceId: string) => void;
	/** Writes every workspace's manifest now (unless held, see above; nothing once closed) and resolves when done. */
	writeAll: (source: "periodic" | "shutdown") => Promise<void>;
	/** Stops the timers; with `finalSource` it writes every workspace once more first (a clean shutdown). */
	close: (options?: { finalSource?: "shutdown" }) => Promise<void>;
}

interface WorkspaceEntry {
	timer: ReturnType<typeof setTimeout> | null;
	queue: Promise<void>;
	/** Cards of the last manifest this writer wrote, to skip change-triggered writes that would change nothing. */
	lastCards: string | null;
	states: Map<string, string>;
	/** The manifest on disk when this writer first looked (undefined: not read yet). */
	inherited: RestartManifest | null | undefined;
}

function isSameFile(a: RestartManifest | null | undefined, b: RestartManifest | null): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b);
}

export function createRestartManifestWriter(deps: CreateRestartManifestWriterDependencies): RestartManifestWriter {
	const now = deps.now ?? Date.now;
	const readManifest = deps.readManifest ?? readRestartManifest;
	const writeManifest =
		deps.writeManifest ??
		((workspaceId: string, manifest: RestartManifest) =>
			writeRestartManifest(workspaceId, manifest, { alreadyLocked: true }));
	const withManifestLock = deps.withManifestLock ?? withRestartManifestLock;
	const intervalMs = deps.intervalMs ?? DEFAULT_RESTART_MANIFEST_INTERVAL_MS;
	const debounceMs = deps.debounceMs ?? DEFAULT_RESTART_MANIFEST_DEBOUNCE_MS;
	const handoverMs = deps.handoverMs ?? DEFAULT_RESTART_MANIFEST_HANDOVER_MS;
	const prepareHoldMs = deps.prepareHoldMs ?? DEFAULT_PREPARE_MANIFEST_HOLD_MS;
	const workspaces = new Map<string, WorkspaceEntry>();
	let interval: ReturnType<typeof setInterval> | null = null;
	let closed = false;

	const entryOf = (workspaceId: string): WorkspaceEntry => {
		let entry = workspaces.get(workspaceId);
		if (!entry) {
			entry = { timer: null, queue: Promise.resolve(), lastCards: null, states: new Map(), inherited: undefined };
			workspaces.set(workspaceId, entry);
		}
		return entry;
	};

	const writeWorkspace = async (
		workspaceId: string,
		entry: WorkspaceEntry,
		source: "periodic" | "shutdown",
		onlyIfChanged: boolean,
	): Promise<void> => {
		const view = await deps.loadWorkspace(workspaceId);
		if (!view) {
			return;
		}
		await withManifestLock(workspaceId, async () => {
			const existing = await readManifest(workspaceId);
			if (entry.inherited === undefined) {
				entry.inherited = existing;
			}
			const at = now();
			if (
				source !== "shutdown" &&
				existing &&
				!existing.plannedAt &&
				isSameFile(entry.inherited, existing) &&
				isManifestForStart(existing, deps.serverStartedAt, deps.previousServerStartedAt) &&
				at - deps.serverStartedAt < handoverMs
			) {
				return; // the previous server's, for restart recovery of this start
			}
			const fromThisServer = existing?.kanbanStart
				? Date.parse(existing.kanbanStart) === deps.serverStartedAt
				: false;
			if (
				fromThisServer &&
				(existing?.source ?? "prepare") === "prepare" &&
				at - Date.parse(existing?.at ?? "") < prepareHoldMs
			) {
				return; // `kanban restart prepare` ran: its manifest is the one for the planned restart
			}
			const cards: RestartManifestCard[] = listRestartManifestCandidates(
				view.board.columns,
				(taskId) => view.sessions[taskId],
			)
				.filter((candidate) => candidate.notListed === null)
				.map((candidate) => ({
					id: candidate.card.id,
					column: candidate.column,
					model: candidate.model,
					wipTag: null,
					kind: candidate.role,
				}));
			const cardsKey = JSON.stringify(cards);
			if (onlyIfChanged && fromThisServer && entry.lastCards === cardsKey) {
				return;
			}
			await writeManifest(workspaceId, {
				at: new Date(at).toISOString(),
				kanbanStart: new Date(deps.serverStartedAt).toISOString(),
				source,
				cards,
			});
			entry.lastCards = cardsKey;
		});
	};

	const enqueue = (workspaceId: string, source: "periodic" | "shutdown", onlyIfChanged: boolean): Promise<void> => {
		const entry = entryOf(workspaceId);
		entry.queue = entry.queue
			.then(() => writeWorkspace(workspaceId, entry, source, onlyIfChanged))
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				deps.warn?.(`Could not write the restart manifest of workspace ${workspaceId}: ${message}`);
			});
		return entry.queue;
	};

	const schedule = (workspaceId: string): void => {
		if (closed) {
			return;
		}
		const entry = entryOf(workspaceId);
		if (entry.timer) {
			return;
		}
		entry.timer = setTimeout(() => {
			entry.timer = null;
			void enqueue(workspaceId, "periodic", true);
		}, debounceMs);
		entry.timer.unref?.();
	};

	const clearTimers = (): void => {
		if (interval) {
			clearInterval(interval);
			interval = null;
		}
		for (const entry of workspaces.values()) {
			if (entry.timer) {
				clearTimeout(entry.timer);
				entry.timer = null;
			}
		}
	};

	const writeAll = async (source: "periodic" | "shutdown"): Promise<void> => {
		await Promise.all(deps.listWorkspaceIds().map((workspaceId) => enqueue(workspaceId, source, false)));
	};

	return {
		start: () => {
			if (closed || interval) {
				return;
			}
			interval = setInterval(() => {
				void writeAll("periodic");
			}, intervalMs);
			interval.unref?.();
			for (const workspaceId of deps.listWorkspaceIds()) {
				const entry = entryOf(workspaceId);
				entry.queue = entry.queue
					.then(async () => {
						if (entry.inherited === undefined) {
							entry.inherited = await readManifest(workspaceId);
						}
					})
					.catch(() => {});
				schedule(workspaceId);
			}
		},
		notifyActivity: (activity) => {
			if (closed) {
				return;
			}
			const { summary } = activity;
			if (summary) {
				const states = entryOf(activity.workspaceId).states;
				if (states.get(summary.taskId) === summary.state) {
					return; // output only: summaries arrive many times a second while agents print
				}
				states.set(summary.taskId, summary.state);
			}
			schedule(activity.workspaceId);
		},
		forgetWorkspace: (workspaceId) => {
			const entry = workspaces.get(workspaceId);
			if (entry?.timer) {
				clearTimeout(entry.timer);
			}
			workspaces.delete(workspaceId);
		},
		writeAll: async (source) => {
			if (!closed) {
				await writeAll(source);
			}
		},
		close: async (options) => {
			if (closed) {
				return;
			}
			closed = true;
			clearTimers();
			if (options?.finalSource) {
				await writeAll(options.finalSource);
			} else {
				await Promise.all(Array.from(workspaces.values(), (entry) => entry.queue));
			}
		},
	};
}
