// Writes that survive a crash. A temp file renamed over the target is atomic for readers, but without an fsync the
// rename can reach the disk before the data: after a power loss, OOM kill of the pod or host crash the target comes
// back 0 bytes (pipeline-state.json at the unclean stop of 2026-10-11 ~17:14Z, issue #36). So the temp file's
// data is synced before the rename, and the directory after it, so the rename itself is on disk too.
import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";

/** Writes `path` (a temp file, normally) and syncs its data to disk before closing it. */
export async function writeFileSynced(
	path: string,
	content: string | Uint8Array,
	options: { mode?: number; flag?: string; encoding?: BufferEncoding } = {},
): Promise<void> {
	const handle = await open(path, options.flag ?? "w", options.mode);
	try {
		await handle.writeFile(content, options.encoding ? { encoding: options.encoding } : {});
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function isUnsupportedSyncError(error: unknown): boolean {
	const code = error && typeof error === "object" && "code" in error ? error.code : null;
	return code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EPERM" || code === "EACCES";
}

/** Syncs a directory entry list (a rename in it). File systems that can't sync a directory are skipped. */
export async function syncDirectory(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		if (!isUnsupportedSyncError(error)) {
			throw error;
		}
	} finally {
		await handle?.close();
	}
}

/** Renames a synced temp file over `path` and syncs the directory, so the new content is what a crash leaves. */
export async function renameDurably(tempPath: string, path: string): Promise<void> {
	await rename(tempPath, path);
	await syncDirectory(dirname(path));
}
