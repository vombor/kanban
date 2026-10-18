import { describe, expect, it } from "vitest";
import type { RuntimeWorkspaceFileChange } from "@/runtime/types";
import { retainWorkspaceDiffFiles } from "@/runtime/workspace-diff-identity";

const file: RuntimeWorkspaceFileChange = {
	path: "src/example.ts",
	status: "modified",
	additions: 1,
	deletions: 1,
	oldText: "old",
	newText: "new",
};

describe("retainWorkspaceDiffFiles", () => {
	it("retains identical file and array identity, including empty polls", () => {
		const previous = [file];
		expect(retainWorkspaceDiffFiles(previous, [{ ...file }])).toBe(previous);
		const empty: RuntimeWorkspaceFileChange[] = [];
		expect(retainWorkspaceDiffFiles(empty, [])).toBe(empty);
	});
	it("retains only unchanged files and respects ordering and removals", () => {
		const other = { ...file, path: "other.ts" };
		const previous = [file, other];
		const changed = { ...other, newText: "changed" };
		const next = retainWorkspaceDiffFiles(previous, [{ ...file }, changed]);
		expect(next).not.toBe(previous);
		expect(next[0]).toBe(file);
		expect(next[1]).toBe(changed);
		expect(retainWorkspaceDiffFiles(previous, [{ ...other }, { ...file }])).toEqual([other, file]);
		expect(retainWorkspaceDiffFiles(previous, [{ ...other }])).toEqual([other]);
	});
	it("does not ignore content, status, stats or null changes", () => {
		for (const changed of [
			{ ...file, previousPath: "old-name.ts" },
			{ ...file, status: "added" as const },
			{ ...file, additions: 2 },
			{ ...file, deletions: 2 },
			{ ...file, oldText: null },
			{ ...file, newText: null },
			{ ...file, newText: "different" },
		]) {
			expect(retainWorkspaceDiffFiles([file], [changed])[0]).toBe(changed);
		}
	});
});
