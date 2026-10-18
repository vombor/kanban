import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { knowledgeMarkdownSchema } from "../trpc/knowledge-contract";
import { discoveryPathSchema } from "../trpc/knowledge-discovery-contract";
import { KnowledgeError } from "./knowledge-error";

export async function safeSourcePath(root: string, path: string): Promise<string> {
	const relative = discoveryPathSchema.parse(path);
	let current = await realpath(root);
	for (const segment of relative.split("/")) {
		current = join(current, segment);
		const info = await lstat(current);
		if (info.isSymbolicLink()) throw new KnowledgeError("FORBIDDEN", "Markdown discovery does not follow symlinks.");
	}
	return current;
}
export async function readSourceMarkdown(root: string, path: string): Promise<string> {
	if (!path.toLowerCase().endsWith(".md"))
		throw new KnowledgeError("BAD_REQUEST", "Only Markdown reference files are readable.");
	const expected = await safeSourcePath(root, path);
	const file = await open(expected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		if (!(await file.stat()).isFile()) throw new KnowledgeError("BAD_REQUEST", "Read a regular Markdown file.");
		// On Linux verify the opened object, not just a pathname that can change between lstat and open.
		if (process.platform === "linux" && (await realpath(`/proc/self/fd/${file.fd}`)) !== expected)
			throw new KnowledgeError("FORBIDDEN", "Reference path changed during its bounded read.");
		const buffer = Buffer.alloc(262145);
		let size = 0;
		while (size < buffer.length) {
			const part = await file.read(buffer, size, buffer.length - size, null);
			if (!part.bytesRead) break;
			size += part.bytesRead;
		}
		if (size > 262144)
			throw new KnowledgeError("PRECONDITION_FAILED", "Reference exceeds the bounded Markdown limit.");
		return knowledgeMarkdownSchema.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)));
	} finally {
		await file.close();
	}
}
export async function listSourceMarkdown(
	root: string,
	project: boolean,
	maxEntries = 1000,
): Promise<{ paths: string[]; truncated: boolean; entries: number }> {
	const paths: string[] = [];
	let entries = 0,
		truncated = false;
	const walk = async (path: string, depth: number): Promise<void> => {
		if (depth > 6 || entries >= maxEntries) {
			truncated = true;
			return;
		}
		const children: Dirent[] = [];
		try {
			const directory = await opendir(path ? await safeSourcePath(root, path) : await realpath(root));
			for await (const entry of directory) {
				if (entries + children.length >= maxEntries) {
					truncated = true;
					break;
				}
				children.push(entry);
			}
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
			if (++entries > maxEntries) {
				truncated = true;
				break;
			}
			if (
				child.name.startsWith(".") ||
				child.isSymbolicLink() ||
				["node_modules", "vendor", "dist", "build", "coverage"].includes(child.name)
			)
				continue;
			const relative = path ? `${path}/${child.name}` : child.name;
			if (!discoveryPathSchema.safeParse(relative).success) continue;
			if (child.isDirectory()) {
				if (!project || path || child.name === "docs") await walk(relative, depth + 1);
			} else if (
				child.isFile() &&
				relative.toLowerCase().endsWith(".md") &&
				(!project || path || ["readme.md", "agents.md", "claude.md"].includes(child.name.toLowerCase()))
			)
				paths.push(relative);
		}
	};
	await walk("", 0);
	return { paths, truncated, entries };
}
