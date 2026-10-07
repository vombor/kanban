import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

const lockfileMocks = vi.hoisted(() => ({
	lock: vi.fn(),
	release: vi.fn(async () => {}),
}));

vi.mock("proper-lockfile", () => ({
	lock: lockfileMocks.lock,
}));

import { LockedFileSystem } from "../../src/fs/locked-file-system";

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("LockedFileSystem", () => {
	beforeEach(() => {
		lockfileMocks.release.mockReset();
		lockfileMocks.release.mockResolvedValue(undefined);
		lockfileMocks.lock.mockReset();
		lockfileMocks.lock.mockResolvedValue(lockfileMocks.release);
	});

	it("omits onCompromised when no handler is provided", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();

			await lockedFileSystem.withLock({ path: filePath, type: "file" }, async () => {});

			expect(lockfileMocks.lock).toHaveBeenCalledTimes(1);
			const options = lockfileMocks.lock.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(options).not.toHaveProperty("onCompromised");
			expect(lockfileMocks.release).toHaveBeenCalledTimes(1);
		} finally {
			tempDir.cleanup();
		}
	});

	it("forwards onCompromised when a handler is provided", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();
			const onCompromised = vi.fn();

			await lockedFileSystem.withLock({ path: filePath, type: "file", onCompromised }, async () => {});

			const options = lockfileMocks.lock.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(options.onCompromised).toBe(onCompromised);
		} finally {
			tempDir.cleanup();
		}
	});
	it("waits for lock operations that are acquiring, holding or releasing a lock", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();
			const lockRequested = createDeferred<void>();
			const acquire = createDeferred<() => Promise<void>>();
			const operationStarted = createDeferred<void>();
			const finishOperation = createDeferred<void>();
			const releaseStarted = createDeferred<void>();
			const finishRelease = createDeferred<void>();
			let released = false;
			lockfileMocks.lock.mockImplementationOnce(async () => {
				lockRequested.resolve();
				return await acquire.promise;
			});
			const operation = lockedFileSystem.withLock({ path: filePath, type: "file" }, async () => {
				operationStarted.resolve();
				await finishOperation.promise;
			});
			let idle = false;
			const waited = lockedFileSystem.waitForPendingLocks().then(() => {
				idle = true;
			});

			// Acquiring.
			await lockRequested.promise;
			expect(idle).toBe(false);
			// Holding.
			acquire.resolve(async () => {
				releaseStarted.resolve();
				await finishRelease.promise;
				released = true;
			});
			await operationStarted.promise;
			expect(idle).toBe(false);
			// Releasing.
			finishOperation.resolve();
			await releaseStarted.promise;
			expect(idle).toBe(false);
			finishRelease.resolve();
			await operation;
			await waited;
			expect(released).toBe(true);
			expect(idle).toBe(true);
		} finally {
			tempDir.cleanup();
		}
	});

	it("is idle right away without lock operations and after a failed one", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const lockedFileSystem = new LockedFileSystem();
			await lockedFileSystem.waitForPendingLocks();
			lockfileMocks.lock.mockRejectedValueOnce(new Error("Lock file is already being held"));
			await expect(
				lockedFileSystem.withLock({ path: join(tempDir.path, "state.json"), type: "file" }, async () => {}),
			).rejects.toThrow(/already being held/u);
			await lockedFileSystem.waitForPendingLocks();
		} finally {
			tempDir.cleanup();
		}
	});
});
