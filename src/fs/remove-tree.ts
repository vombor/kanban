// Deletes a directory tree without ever entering a symlink: every symlink in it (to a file or a directory, inside
// or outside the tree) is unlinked, never followed. Task worktrees hold links into the main checkout (issue #19), so
// their removal must only ever drop the link. Node's own `rm({ recursive: true })` and `git worktree remove` don't
// follow links today either, but a worktree delete must not rest on that.
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Removes `path` (a file, a symlink or a directory tree) like `rm -rf`, unlinking symlinks instead of following. */
export async function removeTreeWithoutFollowingLinks(path: string): Promise<void> {
	const stats = await lstat(path).catch((error: unknown) => {
		if (isMissing(error)) {
			return null;
		}
		throw error;
	});
	if (!stats) {
		return;
	}
	if (!stats.isDirectory()) {
		// A symlink (whatever it points to) or a file: only the entry itself goes.
		await unlink(path).catch((error: unknown) => {
			if (!isMissing(error)) {
				throw error;
			}
		});
		return;
	}
	const entries = await readdir(path).catch((error: unknown) => {
		if (isMissing(error)) {
			return null;
		}
		throw error;
	});
	if (!entries) {
		return;
	}
	// libuv's thread pool bounds the concurrent fs calls; readdir holds no handle open past its own call.
	await Promise.all(entries.map((entry) => removeTreeWithoutFollowingLinks(join(path, entry))));
	await rmdir(path).catch((error: unknown) => {
		if (!isMissing(error)) {
			throw error;
		}
	});
}
