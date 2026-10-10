import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { removeTreeWithoutFollowingLinks } from "../../src/fs/remove-tree";
import { createTempDir } from "../utilities/temp-dir";

describe.skipIf(process.platform === "win32")("removeTreeWithoutFollowingLinks", () => {
	function createOutside(root: string): string {
		const outside = join(root, "outside");
		mkdirSync(join(outside, "pkg"), { recursive: true });
		writeFileSync(join(outside, "pkg", "index.js"), "kept\n");
		writeFileSync(join(outside, "file.txt"), "kept\n");
		return outside;
	}

	it("unlinks root and nested symlinks to directories and files and keeps their targets", async () => {
		const { path: root, cleanup } = createTempDir("kanban-remove-tree-");
		try {
			const outside = createOutside(root);
			const tree = join(root, "tree");
			mkdirSync(join(tree, "tools", "preview"), { recursive: true });
			writeFileSync(join(tree, "tools", "preview", "own.txt"), "gone\n");
			symlinkSync(outside, join(tree, "node_modules"));
			symlinkSync(outside, join(tree, "tools", "preview", "node_modules"));
			symlinkSync(join(outside, "file.txt"), join(tree, ".env"));
			symlinkSync(join(outside, "file.txt"), join(tree, "tools", "dev.db"));
			symlinkSync(join(root, "missing"), join(tree, "dangling"));

			await removeTreeWithoutFollowingLinks(tree);

			expect(existsSync(tree)).toBe(false);
			expect(readFileSync(join(outside, "pkg", "index.js"), "utf8")).toBe("kept\n");
			expect(readFileSync(join(outside, "file.txt"), "utf8")).toBe("kept\n");
		} finally {
			cleanup();
		}
	});

	it("unlinks a path that is itself a symlink", async () => {
		const { path: root, cleanup } = createTempDir("kanban-remove-tree-self-");
		try {
			const outside = createOutside(root);
			const link = join(root, "link");
			symlinkSync(outside, link);

			await removeTreeWithoutFollowingLinks(link);

			expect(existsSync(link)).toBe(false);
			expect(readFileSync(join(outside, "pkg", "index.js"), "utf8")).toBe("kept\n");
		} finally {
			cleanup();
		}
	});

	it("does nothing for a missing path", async () => {
		const { path: root, cleanup } = createTempDir("kanban-remove-tree-missing-");
		try {
			await expect(removeTreeWithoutFollowingLinks(join(root, "nope"))).resolves.toBeUndefined();
		} finally {
			cleanup();
		}
	});
});
