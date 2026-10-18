import type { RuntimeWorkspaceFileChange } from "@/runtime/types";

/** Scope this to one hook/request. No shared cache of private worktree contents. */
export function retainWorkspaceDiffFiles(
	previous: RuntimeWorkspaceFileChange[] | null,
	next: RuntimeWorkspaceFileChange[],
): RuntimeWorkspaceFileChange[] {
	if (!previous) return next;
	const byPath = new Map(previous.map((file) => [file.path, file]));
	const files = next.map((file) => {
		const existing = byPath.get(file.path);
		if (!existing) return file;
		const keys = Object.keys(file) as Array<keyof RuntimeWorkspaceFileChange>;
		return keys.length === Object.keys(existing).length && keys.every((key) => Object.is(file[key], existing[key]))
			? existing
			: file;
	});
	return files.length === previous.length && files.every((file, index) => file === previous[index]) ? previous : files;
}
