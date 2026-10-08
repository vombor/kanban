import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempDir(prefix = "kanban-test-"): { path: string; cleanup: () => void } {
	const path = mkdtempSync(join(tmpdir(), prefix));
	return {
		path,
		cleanup: () =>
			rmSync(path, {
				recursive: true,
				force: true,
				maxRetries: 15,
				retryDelay: 300,
			}),
	};
}

/**
 * The real path of `path`. Code that realpaths (git, /proc, `realpathSync`) reports `/private/var/...` for a
 * macOS tmpdir under `/var/...`, so expectations built from a temp path compare through this.
 */
export function realPath(path: string): string {
	return realpathSync(path);
}
