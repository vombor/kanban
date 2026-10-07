import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
	getDefaultKanbanHomePath,
	getLegacyKanbanHomePath,
	getLegacyTaskWorktreesRootPath,
	KANBAN_HOME_ENV,
	KANBAN_WORKTREES_ENV,
	type KanbanHomeResolution,
	resetKanbanHomeForTests,
	resolveKanbanHome,
} from "../../src/state/kanban-home";
import { createTempDir } from "./temp-dir";

/**
 * - `fresh`: empty user home (resolves `~/.kanban`).
 * - `legacy`: only `~/.cline/kanban` exists (resolves the legacy home and `~/.cline/worktrees`).
 * - `initialized`: `~/.kanban/workspaces` exists.
 */
export type TemporaryKanbanHomeLayout = "fresh" | "legacy" | "initialized";

export interface TemporaryKanbanHome extends KanbanHomeResolution {
	/** The temporary user home (`HOME` / `USERPROFILE`). */
	userHomePath: string;
}

export interface TemporaryKanbanHomeOptions {
	layout?: TemporaryKanbanHomeLayout;
	/** Extra env for the run (for example KANBAN_HOME). Unset variables are cleared. */
	env?: Partial<Record<typeof KANBAN_HOME_ENV | typeof KANBAN_WORKTREES_ENV, string>>;
	/** Runs after the layout is created and before the home is resolved. */
	prepare?: (userHomePath: string) => void;
}

const MANAGED_ENV_KEYS = ["HOME", "USERPROFILE", KANBAN_HOME_ENV, KANBAN_WORKTREES_ENV] as const;

/**
 * Runs `run` with HOME pointing at a temporary directory and the Kanban home resolved inside it.
 * Restores the environment and the resolver cache afterwards. Replaces per-file HOME hacks.
 */
export async function withTemporaryKanbanHome<T>(
	run: (home: TemporaryKanbanHome) => Promise<T> | T,
	options: TemporaryKanbanHomeOptions = {},
): Promise<T> {
	const { path: userHomePath, cleanup } = createTempDir("kanban-home-");
	const previousEnv = new Map(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
	process.env.HOME = userHomePath;
	process.env.USERPROFILE = userHomePath;
	delete process.env[KANBAN_HOME_ENV];
	delete process.env[KANBAN_WORKTREES_ENV];
	for (const [key, value] of Object.entries(options.env ?? {})) {
		if (value !== undefined) {
			process.env[key] = value;
		}
	}
	resetKanbanHomeForTests();
	try {
		const layout = options.layout ?? "fresh";
		if (layout === "legacy") {
			mkdirSync(getLegacyKanbanHomePath(), { recursive: true });
			mkdirSync(getLegacyTaskWorktreesRootPath(), { recursive: true });
		} else if (layout === "initialized") {
			mkdirSync(join(getDefaultKanbanHomePath(), "workspaces"), { recursive: true });
		}
		options.prepare?.(userHomePath);
		return await run({ ...resolveKanbanHome(), userHomePath });
	} finally {
		for (const [key, value] of previousEnv) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		resetKanbanHomeForTests();
		cleanup();
	}
}
