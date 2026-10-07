// `<calibration dir>/runner.pid`: one `kanban bench calibrate` runner per calibration, so two runners started at the
// same moment can't both work on one state.json and create duplicate cards.
//
// The lock is created exclusively: the pid goes into a temporary file that is hard-linked to the lock path (link
// fails when the path exists, and the lock never exists half written). A lock whose holder is dead (a crash, a
// restart) is taken over; that check-and-replace runs under a short lockedFileSystem lock, so of two takeovers only
// one wins, and the replacement is an atomic rename, so the lock path never goes missing for a concurrent create.
import { link, readFile, rm, writeFile } from "node:fs/promises";

import { lockedFileSystem } from "../../../fs/locked-file-system";

export class CalibrationRunnerBusyError extends Error {
	constructor(
		readonly pid: number,
		lockPath: string,
	) {
		super(`already running (pid ${pid}, ${lockPath})`);
		this.name = "CalibrationRunnerBusyError";
	}
}

export interface CalibrationRunnerLockOptions {
	/** The pid written to the lock (this process by default). */
	pid?: number;
	/** Holders the lock is taken over from although they live: the `kanban bench calibrate` that spawned this worker. */
	inheritFrom?: number[];
	isAlive?: (pid: number) => boolean;
}

export interface CalibrationRunnerLock {
	/** Passes the lock to `pid` (the detached worker), if this process still holds it. */
	handOver: (pid: number) => Promise<void>;
	/** Removes the lock, if this process still holds it. */
	release: () => Promise<void>;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parsePid(text: string): number | null {
	const pid = Number(text.trim());
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function readHolder(lockPath: string): Promise<number | null> {
	return parsePid(await readFile(lockPath, "utf8").catch(() => ""));
}

async function createExclusive(lockPath: string, pid: number): Promise<boolean> {
	const temporary = `${lockPath}.${pid}.${process.pid}.tmp`;
	await writeFile(temporary, `${pid}\n`);
	try {
		await link(temporary, lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return false;
		}
		throw error;
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Takes the runner lock or throws CalibrationRunnerBusyError with the live holder's pid. */
export async function acquireCalibrationRunnerLock(
	lockPath: string,
	options: CalibrationRunnerLockOptions = {},
): Promise<CalibrationRunnerLock> {
	const isAlive = options.isAlive ?? isProcessAlive;
	let owner = options.pid ?? process.pid;
	const ifHeld = async (operation: () => Promise<void>): Promise<void> => {
		await lockedFileSystem.withLock({ path: lockPath }, async () => {
			if ((await readHolder(lockPath)) === owner) {
				await operation();
			}
		});
	};
	if (!(await createExclusive(lockPath, owner))) {
		await lockedFileSystem.withLock({ path: lockPath }, async () => {
			const holder = await readHolder(lockPath);
			if (holder !== null && holder !== owner && !options.inheritFrom?.includes(holder) && isAlive(holder)) {
				throw new CalibrationRunnerBusyError(holder, lockPath);
			}
			await lockedFileSystem.writeTextFileAtomic(lockPath, `${owner}\n`, { lock: null });
		});
	}
	return {
		handOver: async (pid) => {
			await ifHeld(async () => {
				await lockedFileSystem.writeTextFileAtomic(lockPath, `${pid}\n`, { lock: null });
				owner = pid;
			});
		},
		release: async () => {
			await ifHeld(async () => {
				await rm(lockPath, { force: true });
			});
		},
	};
}
