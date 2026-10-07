// A Cline card's own `.cline/hooks` and `.cline/rules`. Kanban's hook scripts carry the card's identity (its ids and
// guard policy), and Cline 3.x runs the scripts it finds in the session's workspace `.cline/hooks`. A project that
// git-ignores `.cline/` gets it mirrored into every task worktree as a symlink to the main checkout's directory
// (task-worktree.ts), so every card of the project shared one hooks dir and the card launched last wrote everyone's
// hooks: foo 4189a's writes were judged against 6f756's worktree (10/07). Before a Cline launch writes its hooks, a
// mirrored `.cline` becomes a real directory of the card: its other entries stay links to the shared ones, and
// `hooks`/`rules` hold links to the user's own files only, so Kanban's files there are the card's.
import { lstat, mkdir, readdir, readFile, realpath, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";

import { readSymlinkedIgnoredPaths } from "../workspace/task-worktree";

export const KANBAN_MANAGED_CLINE_CLI_HOOK_MARKER = "kanban-managed: cline-cli hook";
export const KANBAN_MANAGED_CLINE_RULE_MARKER = "<!-- kanban-managed: cline rule -->";
/** The orchestrator's appended system prompt as a workspace rule (no marker line); never a card's. */
export const KANBAN_HOME_AGENT_CLINE_RULE_FILE = "kanban-home-agent.md";

const CARD_OWNED_SUBDIRS = new Set(["hooks", "rules"]);

async function isKanbanClineFile(path: string, name: string): Promise<boolean> {
	if (name === KANBAN_HOME_AGENT_CLINE_RULE_FILE) {
		return true;
	}
	const content = await readFile(path, "utf8").catch(() => "");
	return (
		content.includes(KANBAN_MANAGED_CLINE_CLI_HOOK_MARKER) || content.startsWith(KANBAN_MANAGED_CLINE_RULE_MARKER)
	);
}

async function linkEntry(target: string, path: string, isDirectory: boolean): Promise<void> {
	await symlink(target, path, isDirectory ? "dir" : "file").catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") {
			throw error;
		}
	});
}

async function unshareMirroredClineDir(clineDir: string): Promise<void> {
	const sharedDir = await realpath(clineDir).catch(() => null);
	await unlink(clineDir);
	await mkdir(clineDir, { recursive: true });
	if (!sharedDir) {
		return;
	}
	for (const entry of await readdir(sharedDir, { withFileTypes: true })) {
		const sharedPath = join(sharedDir, entry.name);
		const cardPath = join(clineDir, entry.name);
		if (!CARD_OWNED_SUBDIRS.has(entry.name) || !entry.isDirectory()) {
			await linkEntry(sharedPath, cardPath, entry.isDirectory());
			continue;
		}
		await mkdir(cardPath, { recursive: true });
		for (const file of await readdir(sharedPath, { withFileTypes: true })) {
			const sharedFilePath = join(sharedPath, file.name);
			if (file.isFile() && (await isKanbanClineFile(sharedFilePath, file.name))) {
				continue;
			}
			await linkEntry(sharedFilePath, join(cardPath, file.name), file.isDirectory());
		}
	}
}

/**
 * Makes `<cwd>/.cline/hooks` the card's own directory before Kanban writes its hook scripts there. Throws, and the
 * launch fails, when it can't: a `.cline` or `.cline/hooks` symlink Kanban didn't mirror would make the card's
 * hooks another place's, and replacing it would change the user's tree.
 */
export async function ensureCardOwnedClineDir(cwd: string): Promise<void> {
	const clineDir = join(cwd, ".cline");
	const clineStat = await lstat(clineDir).catch(() => null);
	if (clineStat?.isSymbolicLink()) {
		if (!(await readSymlinkedIgnoredPaths(cwd)).includes(".cline")) {
			throw new Error(
				`${clineDir} is a symlink Kanban didn't create, so this card's Cline hooks would be shared with ${await realpath(clineDir).catch(() => "its target")}. Replace it with a directory to run Cline cards here.`,
			);
		}
		await unshareMirroredClineDir(clineDir);
	}
	const hooksDir = join(clineDir, "hooks");
	if ((await lstat(hooksDir).catch(() => null))?.isSymbolicLink()) {
		throw new Error(
			`${hooksDir} is a symlink, so this card's Cline hooks would be shared with ${await realpath(hooksDir).catch(() => "its target")}. Replace it with a directory to run Cline cards here.`,
		);
	}
}
