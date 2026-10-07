// Periodic sweep for processes left behind in task worktrees (`processes.reaper` in config.json).
//
// Every process whose cwd or executable is under a worktree root (current and legacy roots, see
// kanban-home.ts) is attributed to a card by its path, `<root>/<taskId>/<project folder>`. It is an orphan when
//   - its card is Done (`card_done`), or
//   - its cwd was deleted and the worktree is gone or the card is not active (`worktree_deleted`), or
//   - a registered project owns the folder but has no such card (`card_missing`).
// Only orphans whose card is Done on a readable board are terminated, whatever the reason. Everything else
// is only reported: a missing card, a card on no board or on an unreadable board says nothing, because a
// second Kanban home sees the same legacy roots with its own boards. Shared processes (the Cline hub daemon,
// anything other cards connect to, see process-reaper.ts) are never terminated. With `mode: "report"`, or
// with the sweep disabled (a manual "Sweep now"), nothing is terminated.
// Zombies (state Z) can't be killed; the ones whose parent is the server or a worktree process are reported.
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type {
	RuntimeBoardData,
	RuntimeProcessCardStatus,
	RuntimeProcessOrphan,
	RuntimeProcessOrphanReason,
	RuntimeProcessReaperSettings,
	RuntimeProcessSweepCard,
	RuntimeProcessSweepResponse,
	RuntimeProcessSweepResult,
	RuntimeProcessZombie,
} from "../core/api-contract";
import { isPathWithinRoot } from "../workspace/path-sandbox";
import { getWorkspaceFolderLabelForWorktreePath } from "../workspace/task-worktree-path";
import { expandPathVariants, formatRss, type ProcessReaper, type ReapTarget } from "./process-reaper";
import type { ProcessEntry } from "./process-table";

/** The first sweep runs this soon after startup (or after one interval, if that is shorter). */
const FIRST_SWEEP_DELAY_MS = 60_000;

export interface WorkspaceBoardSnapshot {
	workspaceId: string;
	repoPath: string;
	/** Null when the board could not be read; cards of that project are then `unknown`, never reaped. */
	board: RuntimeBoardData | null;
}

export interface OrphanProcessSweeperDependencies {
	reaper: ProcessReaper;
	getWorktreeRoots: () => string[];
	listWorkspaceBoards: () => Promise<WorkspaceBoardSnapshot[]>;
	loadSettings: () => Promise<RuntimeProcessReaperSettings>;
	log: (message: string) => void;
	pathExists?: (path: string) => boolean;
	now?: () => number;
}

export interface OrphanProcessSweeper {
	sweep: () => Promise<RuntimeProcessSweepResult>;
	getStatus: () => Promise<RuntimeProcessSweepResponse>;
	start: () => void;
	close: () => void;
}

interface WorktreeLocation {
	taskId: string;
	/** `<root>/<taskId>/<folder>`, or `<root>/<taskId>` when the process sits directly in the task dir. */
	worktreePath: string;
	folder: string | null;
}

interface CardLookup {
	status: RuntimeProcessCardStatus;
	workspaceId: string | null;
}

function locateInRoots(path: string | null, roots: readonly string[]): WorktreeLocation | null {
	if (path === null) {
		return null;
	}
	for (const root of roots) {
		if (!isPathWithinRoot(root, path)) {
			continue;
		}
		const [taskId, folder] = relative(root, path).split(sep).filter(Boolean);
		if (!taskId) {
			return null;
		}
		return {
			taskId,
			folder: folder ?? null,
			worktreePath: folder ? join(root, taskId, folder) : join(root, taskId),
		};
	}
	return null;
}

function locateProcess(entry: ProcessEntry, roots: readonly string[]): WorktreeLocation | null {
	return locateInRoots(entry.cwd, roots) ?? locateInRoots(entry.exe, roots);
}

function findCardColumn(board: RuntimeBoardData, taskId: string): string | null {
	for (const column of board.columns) {
		if (column.cards.some((card) => card.id === taskId)) {
			return column.id;
		}
	}
	return null;
}

function createCardLookup(workspaces: readonly WorkspaceBoardSnapshot[]) {
	const withFolder = workspaces.map((workspace) => ({
		...workspace,
		folder: getWorkspaceFolderLabelForWorktreePath(workspace.repoPath),
	}));
	return (location: WorktreeLocation): CardLookup => {
		const owners = withFolder.filter((workspace) => location.folder === null || workspace.folder === location.folder);
		let done: string | null = null;
		for (const owner of owners) {
			const columnId = owner.board ? findCardColumn(owner.board, location.taskId) : null;
			if (columnId && columnId !== "trash") {
				return { status: "active", workspaceId: owner.workspaceId };
			}
			if (columnId === "trash") {
				done ??= owner.workspaceId;
			}
		}
		if (done) {
			return { status: "done", workspaceId: done };
		}
		const allRead = owners.length > 0 && owners.every((owner) => owner.board !== null);
		return allRead && location.folder !== null
			? { status: "missing", workspaceId: owners[0]?.workspaceId ?? null }
			: { status: "unknown", workspaceId: null };
	};
}

function getOrphanReason(
	entry: ProcessEntry,
	location: WorktreeLocation,
	card: CardLookup,
	pathExists: (path: string) => boolean,
): RuntimeProcessOrphanReason | null {
	if (entry.cwdDeleted && (card.status !== "active" || !pathExists(location.worktreePath))) {
		return "worktree_deleted";
	}
	if (card.status === "done") {
		return "card_done";
	}
	if (card.status === "missing") {
		return "card_missing";
	}
	return null;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createOrphanProcessSweeper(deps: OrphanProcessSweeperDependencies): OrphanProcessSweeper {
	const now = (): number => deps.now?.() ?? Date.now();
	const pathExists = deps.pathExists ?? existsSync;
	let lastSweep: RuntimeProcessSweepResult | null = null;
	let running: Promise<RuntimeProcessSweepResult> | null = null;
	let timer: NodeJS.Timeout | null = null;
	let closed = false;

	const runSweep = async (): Promise<RuntimeProcessSweepResult> => {
		const startedAt = now();
		const settings = await deps.loadSettings();
		const result: RuntimeProcessSweepResult = {
			startedAt,
			finishedAt: startedAt,
			// A manual sweep while the periodic one is disabled only reports.
			mode: settings.enabled ? settings.mode : "report",
			processCount: 0,
			rssBytes: 0,
			cards: [],
			orphans: [],
			zombies: [],
			error: null,
		};
		try {
			const roots = expandPathVariants(deps.getWorktreeRoots());
			const [snapshot, workspaces] = await Promise.all([deps.reaper.snapshot(), deps.listWorkspaceBoards()]);
			const lookupCard = createCardLookup(workspaces);
			const cards = new Map<string, RuntimeProcessSweepCard>();
			const inWorktrees = new Set<number>();
			const orphans: Array<{
				entry: ProcessEntry;
				taskId: string;
				reason: RuntimeProcessOrphanReason;
				target: ReapTarget | null;
			}> = [];

			for (const entry of snapshot.entries) {
				if (entry.state === "Z" || snapshot.protectedPids.has(entry.pid)) {
					continue;
				}
				const location = locateProcess(entry, roots);
				if (!location) {
					continue;
				}
				inWorktrees.add(entry.pid);
				const card = lookupCard(location);
				const summary = cards.get(location.taskId) ?? {
					taskId: location.taskId,
					workspaceId: card.workspaceId,
					status: card.status,
					processCount: 0,
					rssBytes: 0,
				};
				summary.processCount += 1;
				summary.rssBytes += entry.rssBytes;
				cards.set(location.taskId, summary);
				const reason = getOrphanReason(entry, location, card, pathExists);
				if (reason) {
					const target =
						card.status === "done" ? { entry, ownPaths: expandPathVariants([location.worktreePath]) } : null;
					orphans.push({ entry, taskId: location.taskId, reason, target });
				}
			}

			const targets = orphans.flatMap((orphan) => (orphan.target ? [orphan.target] : []));
			const outcomeList =
				result.mode === "terminate" ? await deps.reaper.terminate(targets) : await deps.reaper.findShared(targets);
			const outcomes = new Map(outcomeList.map((outcome) => [outcome.entry.pid, outcome]));
			result.orphans = orphans.map(({ entry, taskId, reason, target }): RuntimeProcessOrphan => {
				const outcome = outcomes.get(entry.pid);
				const shared = outcome?.action === "shared" || outcome?.action === "shared_daemon";
				const orphan: RuntimeProcessOrphan = {
					pid: entry.pid,
					taskId,
					command: entry.command,
					cwd: entry.cwd,
					rssBytes: entry.rssBytes,
					reason,
					action: outcome?.action ?? "reported",
					eligible: target !== null && !shared,
					...(outcome?.error ? { error: outcome.error } : {}),
					...(outcome?.detail ? { detail: outcome.detail } : {}),
				};
				const note = orphan.error ?? orphan.detail;
				deps.log(
					`[process-reaper] ${orphan.action} orphan pid ${orphan.pid} of card ${taskId} (${reason}, ${formatRss(orphan.rssBytes)}): ${orphan.command}${note ? ` (${note})` : ""}`,
				);
				return orphan;
			});

			result.zombies = snapshot.entries
				.filter(
					(entry) =>
						entry.state === "Z" &&
						(entry.ppid === deps.reaper.serverPid || inWorktrees.has(entry.ppid) || locateProcess(entry, roots)),
				)
				.map((entry): RuntimeProcessZombie => {
					const zombie = {
						pid: entry.pid,
						ppid: entry.ppid,
						command: entry.command,
						parentCommand: snapshot.byPid.get(entry.ppid)?.command ?? null,
					};
					deps.log(
						`[process-reaper] zombie pid ${zombie.pid} (parent ${zombie.ppid}: ${zombie.parentCommand ?? "?"}): ${zombie.command}`,
					);
					return zombie;
				});
			result.cards = [...cards.values()].sort((a, b) => b.rssBytes - a.rssBytes);
			result.processCount = inWorktrees.size;
			result.rssBytes = result.cards.reduce((total, card) => total + card.rssBytes, 0);
		} catch (error) {
			result.error = toErrorMessage(error);
			deps.log(`[process-reaper] sweep failed: ${result.error}`);
		}
		result.finishedAt = now();
		lastSweep = result;
		return result;
	};

	const sweep = (): Promise<RuntimeProcessSweepResult> => {
		running ??= runSweep().finally(() => {
			running = null;
		});
		return running;
	};

	const schedule = (delayMs: number): void => {
		if (closed) {
			return;
		}
		timer = setTimeout(() => {
			void tick();
		}, delayMs);
		timer.unref();
	};

	const tick = async (): Promise<void> => {
		const settings = await deps.loadSettings();
		try {
			if (settings.enabled) {
				await sweep();
			}
		} finally {
			schedule(settings.intervalSec * 1000);
		}
	};

	return {
		sweep,
		getStatus: async () => ({
			supported: deps.reaper.supported,
			settings: await deps.loadSettings(),
			lastSweep,
		}),
		start: () => {
			if (!deps.reaper.supported) {
				deps.log(`[process-reaper] process cleanup needs /proc; it is off on ${process.platform}.`);
				return;
			}
			void deps.loadSettings().then((settings) => {
				schedule(Math.min(FIRST_SWEEP_DELAY_MS, settings.intervalSec * 1000));
			});
		},
		close: () => {
			closed = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}
