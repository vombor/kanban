// Which card a Cline hook call belongs to. Cline 3.x runs `.cline/hooks` scripts in its shared hub daemon, whose env
// (KANBAN_HOOK_*, the daemon's own cwd) is the first Cline card's, so Kanban's scripts carry the card's identity
// themselves (`--task-id`/`--workspace-id`, the guard policy's worktree). The payload says which session called:
// cline 3.0.69 sends `workspaceRoots: [<the session's workspace root>]` (its `workspaceRoot ?? cwd`, the card's
// worktree) with every hook event. A hook whose script names another worktree, or a payload without a root, is
// refused: never act for the wrong card, and never guess one from the env.
import { realpathSync } from "node:fs";

export const CLINE_HOOK_WORKSPACE_ROOT_FLAG = "--workspace-root";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The session's workspace root from a Cline hook payload, or null when it has none. */
export function readClineHookWorkspaceRoot(payload: unknown): string | null {
	const roots = asRecord(payload)?.workspaceRoots;
	const root = Array.isArray(roots) ? roots[0] : null;
	return typeof root === "string" && root.trim().length > 0 ? root.trim() : null;
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Null when the payload's session works in `expectedRoot` (the worktree the hook script was written for), else why not. */
export function checkClineHookWorkspaceRoot(payload: unknown, expectedRoot: string): string | null {
	const root = readClineHookWorkspaceRoot(payload);
	if (!root) {
		return `Kanban's Cline hook for ${expectedRoot} got a payload without workspaceRoots, so it can't tell which card's session called it. Refusing rather than guessing.`;
	}
	if (root === expectedRoot || realpathOrSelf(root) === realpathOrSelf(expectedRoot)) {
		return null;
	}
	return `Kanban's Cline hook was written for the card in ${expectedRoot}, but this Cline session works in ${root}: its .cline/hooks are shared with another card. Restart this card (kanban task resume) so Kanban writes its own hooks.`;
}
